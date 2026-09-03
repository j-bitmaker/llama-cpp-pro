export interface ModelManifestEntry {
    modelId: string;
    path: string;
    sizeBytes: number;
    sha256?: string;
    sourceUrl?: string;
    createdAt: number;
    lastUsedAt: number;
}
export declare function listManifestEntries(): Promise<ModelManifestEntry[]>;
export declare function getManifestEntry(modelId: string): Promise<ModelManifestEntry | undefined>;
export declare function upsertManifestEntry(entry: ModelManifestEntry): Promise<void>;
export declare function removeManifestEntry(modelId: string): Promise<void>;
