// This file extends the AdapterConfig type from "@iobroker/types"
// using the actual properties present in io-package.json
// in order to provide typings for adapter.config properties

export {};

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            host: string;
            apiPath: string;
            apiToken: string;
            mbusEnabled: boolean;
            mbusMoxas: Array<Record<string, any>>;
            mbusUnits: Array<Record<string, any>>;
            mbusRouters: Array<Record<string, any>>;
            mbusMeters: Array<Record<string, any>>;
            mbusSettings: Array<Record<string, any>>;
            mbusToken1: string;
            mbusToken2: string;
            mbusToken3: string;
            mbusToken4: string;
            moxaPassword: string;
            sourceType: "solarlogJournal" | "counters";
            journalStateId: string;
            unitMap: { source: string; target: string; skip: boolean }[];
            snapshotTime: string;
            staleMinutes: number;
            meters: {
                name: string;
                stateId: string;
                unit: string;
                mode: string;
            }[];
            production: { stateId: string; unit: string; mode: string }[];
            feedin: { stateId: string; unit: string; mode: string }[];
        }
    }
}
