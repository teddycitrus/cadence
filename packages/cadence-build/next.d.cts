/** Loads the Cadence source-location loader into a Next.js config (webpack and Turbopack) when CADENCE=1. */
export declare function withCadence<T extends object>(config: T): T;
export declare function withCadence<A extends unknown[], T extends object>(config: (...args: A) => T | Promise<T>): (...args: A) => Promise<T>;
declare const _default: typeof withCadence;
export default _default;
