import type { SnippetSignatureFontConfig, SnippetUiFontConfig } from './app';
/**
 * Default CSS font-family stack for the snippet UI.
 * `system-ui, sans-serif` is the fallback when Open Sans isn't loaded.
 */
export declare const DEFAULT_UI_FONT_FAMILY = "'Open Sans', system-ui, sans-serif";
/**
 * Default Google Fonts stylesheet URL for the snippet UI font (Open Sans).
 */
export declare const DEFAULT_UI_FONT_URL = "https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600&display=swap";
/**
 * Default Google Fonts stylesheet URL for the signature "Type" tab.
 */
export declare const DEFAULT_SIGNATURE_FONTS_URL = "https://fonts.googleapis.com/css2?family=Caveat&family=Dancing+Script&family=Great+Vibes&family=Pacifico&display=swap";
/**
 * Default font list for the signature "Type" tab.
 */
export declare const DEFAULT_SIGNATURE_FONTS: ReadonlyArray<{
    name: string;
    family: string;
}>;
export interface ResolvedUiFontConfig {
    family: string;
    stylesheetUrl: string | null;
}
export interface ResolvedSignatureFontsConfig {
    fonts: ReadonlyArray<{
        name: string;
        family: string;
    }>;
    stylesheetUrl: string | null;
    /**
     * Whether the signature "Type" tab should be shown. False when the snippet
     * manages no stylesheet AND the integrator has not provided a fonts list.
     */
    enabled: boolean;
}
/**
 * Resolves the UI font config from `config.fonts?.ui`.
 *
 * - `undefined`: full default — Open Sans family + Google Fonts URL.
 * - `null`: full opt-out — default family stack, no `<link>`.
 * - object: caller takes over. Each field is independent: `family` falls
 *   back to the default stack when omitted, and `stylesheetUrl` falls back
 *   to `null` (no managed `<link>`) when omitted. There is no implicit
 *   default-URL fallback when only `family` is specified, since loading
 *   Open Sans while rendering a different family is almost never intended.
 */
export declare function resolveUiFontConfig(value: SnippetUiFontConfig | null | undefined): ResolvedUiFontConfig;
/**
 * Resolves the signature "Type" tab font config from `config.fonts?.signature`.
 *
 * - `undefined`: full default — built-in font list + Google Fonts URL.
 * - `null`: full opt-out — no `<link>` and no "Type" tab.
 * - object: caller takes over. `fonts` falls back to the built-in list when
 *   omitted or empty; `stylesheetUrl` falls back to `null` when omitted.
 */
export declare function resolveSignatureFontsConfig(value: SnippetSignatureFontConfig | null | undefined): ResolvedSignatureFontsConfig;
//# sourceMappingURL=font-config.d.ts.map