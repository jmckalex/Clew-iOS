export type FontLinkKind = 'ui' | 'signature';
export declare function ensureFontStylesheet(kind: FontLinkKind, href: string, familyStacks?: string[]): HTMLLinkElement | null;
export declare function waitForStylesheet(link: HTMLLinkElement | null): Promise<void>;
export declare function preloadFontFamilies(familyStacks: string[], size?: number): Promise<unknown>;
//# sourceMappingURL=font-loader.d.ts.map