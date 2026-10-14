import type { File } from "@babel/types";
import type { SourceMap } from "magic-string";

export declare const LOC_ATTR: "data-cadence-loc";
export declare const LOCK_ATTR: "data-cadence-locked";
export declare function parseSource(code: string): File;
export declare function stampLocations(code: string, relPath: string): { code: string; map: SourceMap } | null;
export declare function enabled(): boolean;
