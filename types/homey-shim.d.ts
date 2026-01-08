// Minimal Homey SDK typings used in this project. Provides just enough surface
// to satisfy TypeScript without pulling in the full SDK typings in every file.
declare namespace Homey {
    class App {
        log(...args: any[]): void;
        error(...args: any[]): void;
        onInit(): Promise<void> | void;
    }

    class Driver {
        log(...args: any[]): void;
        error(...args: any[]): void;
        onInit(): Promise<void> | void;
    }

    class Device {
        homey: any;
        log(...args: any[]): void;
        error(...args: any[]): void;
        getAvailable(): boolean;
        getData(): any;
        getSetting(key: string): any;
        hasCapability(capabilityId: string): boolean;
        addCapability(capabilityId: string): Promise<void>;
        removeCapability(capabilityId: string): Promise<void>;
        setCapabilityValue(capabilityId: string, value: any): Promise<any>;
        getCapabilityValue(capabilityId: string): any;
        registerCapabilityListener(capabilityId: string, listener: (value: any, opts?: any) => Promise<any> | any, opts?: any): Promise<void>;
    }
}

declare module 'homey' {
    export = Homey;
}
