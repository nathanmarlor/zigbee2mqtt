import ExtensionTS from './extensionts';
import logger from '../util/logger';
import {sleep} from '../util/utils';
import * as settings from '../util/settings';

const hours = (hours: number): number => 1000 * 60 * 60 * hours;
const minutes = (minutes: number): number => 1000 * 60 * minutes;
const seconds = (seconds: number): number => 1000 * seconds;

// TODO
// - State retrieval
// - Home Assistant add availability mode
// - Honour legacy availability_timeout, availability_blocklist and availability_passlist options.
class AvailabilityNew extends ExtensionTS {
    private timers: {[s: string]: NodeJS.Timeout} = {};
    private availabilityCache: {[s: string]: boolean} = {};
    private pingQueue: ResolvedEntity[] = [];
    private pingQueueExecuting = false;

    constructor(zigbee: TempZigbee, mqtt: TempMQTT, state: TempState,
        publishEntityState: TempPublishEntityState, eventBus: TempEventBus) {
        super(zigbee, mqtt, state, publishEntityState, eventBus);
        this.lastSeenChanged = this.lastSeenChanged.bind(this);
        logger.warn('Using experimental new availability feature');
    }

    private isEnabledForDevice(re: ResolvedEntity): boolean {
        return re.settings.hasOwnProperty('availability') ? !!re.settings.availability : !!settings.get().availability;
    }

    private getTimeout(re: ResolvedEntity): number {
        if (typeof re.settings.availability === 'object' && re.settings.availability?.timeout != null) {
            return minutes(re.settings.availability.timeout);
        }

        const key = this.isActiveDevice(re) ? 'active' : 'passive';
        const availabilitySettings = settings.get().availability;
        if (typeof availabilitySettings === 'object' && availabilitySettings[key]?.timeout != null) {
            return minutes(availabilitySettings[key]?.timeout);
        }

        return key === 'active' ? minutes(10) : hours(25);
    }

    private isActiveDevice(re: ResolvedEntity): boolean {
        return (re.device.type === 'Router' && re.device.powerSource !== 'Battery') ||
            re.device.powerSource === 'Mains (single phase)';
    }

    private isAvailable(re: ResolvedEntity): boolean {
        const ago = Date.now() - re.device.lastSeen;
        return ago < this.getTimeout(re);
    }

    private resetTimer(re: ResolvedEntity): void {
        clearTimeout(this.timers[re.device.ieeeAddr]);

        // If the timer triggers, the device is not avaiable anymore otherwise resetTimer already have been called
        if (this.isActiveDevice(re)) {
            // If device did not check in, ping it, if that fails it will be marked as offline
            this.timers[re.device.ieeeAddr] = setTimeout(
                () => this.addToPingQueue(re), this.getTimeout(re) + seconds(1));
        } else {
            this.timers[re.device.ieeeAddr] = setTimeout(
                () => this.publishAvailability(re, true), this.getTimeout(re) + seconds(1));
        }
    }

    private addToPingQueue(re: ResolvedEntity): void {
        this.pingQueue.push(re);
        this.pingQueueExecuteNext();
    }

    private removeFromPingQueue(re: ResolvedEntity): void {
        const index = this.pingQueue.findIndex((r) => r.device.ieeeAddr === re.device.ieeeAddr);
        index != -1 && this.pingQueue.splice(index, 1);
    }

    private async pingQueueExecuteNext(): Promise<void> {
        if (this.pingQueue.length === 0 || this.pingQueueExecuting) return;
        this.pingQueueExecuting = true;

        const re = this.pingQueue[0];
        let pingedSuccessfully = false;
        const available = this.availabilityCache[re.device.ieeeAddr] || this.isAvailable(re);
        const attempts = available ? 2 : 1;
        for (let i = 0; i < attempts; i++) {
            try {
                // Enable recovery if device is marked as available and first ping fails.
                const disableRecovery = !(i == 1 && available);
                await re.device.ping(disableRecovery);
                pingedSuccessfully = true;
                logger.debug(`Succesfully pinged '${re.name}' (attempt ${i + 1}/${attempts})`);
                break;
            } catch (error) {
                logger.error(`Failed to ping '${re.name}' (attempt ${i + 1}/${attempts}, ${error.message})`);
                // Try again in 3 seconds.
                const lastAttempt = i - 1 === attempts;
                !lastAttempt && await sleep(3);
            }
        }

        this.publishAvailability(re, !pingedSuccessfully);
        this.resetTimer(re);
        this.removeFromPingQueue(re);

        // Sleep 2 seconds before executing next ping
        await sleep(2);
        this.pingQueueExecuting = false;
        this.pingQueueExecuteNext();
    }

    override onMQTTConnected(): void {
        for (const device of this.zigbee.getClients()) {
            const re: ResolvedEntity = this.zigbee.resolveEntity(device);

            // Publish initial availablility
            this.publishAvailability(re, true);

            if (this.isEnabledForDevice(re)) {
                this.resetTimer(re);

                // If an active device is initially unavailable, ping it.
                if (this.isActiveDevice(re) && !this.isAvailable(re)) {
                    this.addToPingQueue(re);
                }
            }
        }
    }

    override onZigbeeStarted(): void {
        this.zigbee.on('lastSeenChanged', this.lastSeenChanged);
    }

    private publishAvailability(re: ResolvedEntity, logLastSeen: boolean): void {
        const enabled = this.isEnabledForDevice(re);
        if (enabled && logLastSeen) {
            const ago = Date.now() - re.device.lastSeen;
            if (this.isActiveDevice(re)) {
                logger.debug(
                    `Active device '${re.name}' was last seen '${(ago / minutes(1)).toFixed(2)}' minutes ago.`);
            } else {
                logger.debug(`Passive device '${re.name}' was last seen '${(ago / hours(1)).toFixed(2)}' hours ago.`);
            }
        }

        const available = enabled ? this.isAvailable(re) : true;
        if (this.availabilityCache[re.device.ieeeAddr] == available) {
            return;
        }

        const topic = `${re.name}/availability`;
        const payload = available ? 'online' : 'offline';
        this.availabilityCache[re.device.ieeeAddr] = available;
        this.mqtt.publish(topic, payload, {retain: true, qos: 0});
    }

    private lastSeenChanged(data: {device: Device}): void {
        const re = this.zigbee.resolveEntity(data.device);
        if (this.isEnabledForDevice(re)) {
            // Remove from ping queue, not necessary anymore since we know the device is online.
            this.removeFromPingQueue(re);
            this.resetTimer(re);
            this.publishAvailability(re, false);
        }
    }

    override stop(): void {
        Object.values(this.timers).forEach((t) => clearTimeout(t));
        this.zigbee.removeListener('lastSeenChanged', this.lastSeenChanged);
        super.stop();
    }
}

module.exports = AvailabilityNew;