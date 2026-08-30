import { h } from 'preact';
import { PluginRegistry, PermissionConfig } from '@embedpdf/core';
import type { FontFallbackConfig } from '@embedpdf/engines';
import { ViewportPluginConfig } from '@embedpdf/plugin-viewport/preact';
import { ScrollPluginConfig } from '@embedpdf/plugin-scroll/preact';
import { SpreadPluginConfig } from '@embedpdf/plugin-spread/preact';
import { UIPluginConfig } from '@embedpdf/plugin-ui/preact';
import { DocumentManagerPluginConfig } from '@embedpdf/plugin-document-manager/preact';
import { CommandsPluginConfig } from '@embedpdf/plugin-commands/preact';
import { I18nPluginConfig } from '@embedpdf/plugin-i18n/preact';
import { ZoomPluginConfig } from '@embedpdf/plugin-zoom/preact';
import { RenderPluginConfig } from '@embedpdf/plugin-render/preact';
import { RotatePluginConfig } from '@embedpdf/plugin-rotate/preact';
import { SearchPluginConfig } from '@embedpdf/plugin-search/preact';
import { SelectionPluginConfig } from '@embedpdf/plugin-selection/preact';
import { TilingPluginConfig } from '@embedpdf/plugin-tiling/preact';
import { ThumbnailPluginConfig } from '@embedpdf/plugin-thumbnail/preact';
import { AnnotationPluginConfig } from '@embedpdf/plugin-annotation/preact';
import { PrintPluginConfig } from '@embedpdf/plugin-print/preact';
import { FullscreenPluginConfig } from '@embedpdf/plugin-fullscreen/preact';
import { BookmarkPluginConfig } from '@embedpdf/plugin-bookmark/preact';
import { ExportPluginConfig } from '@embedpdf/plugin-export/preact';
import { InteractionManagerPluginConfig } from '@embedpdf/plugin-interaction-manager/preact';
import { PanPluginConfig } from '@embedpdf/plugin-pan/preact';
import { CapturePluginConfig } from '@embedpdf/plugin-capture/preact';
import { HistoryPluginConfig } from '@embedpdf/plugin-history/preact';
import { RedactionPluginConfig } from '@embedpdf/plugin-redaction/preact';
import { AttachmentPluginConfig } from '@embedpdf/plugin-attachment/preact';
import { FormPluginConfig } from '@embedpdf/plugin-form/preact';
import { StampPluginConfig } from '@embedpdf/plugin-stamp/preact';
import { SignaturePluginConfig } from '@embedpdf/plugin-signature/preact';
import { ThemeConfig } from '@/config/theme';
import { IconsConfig } from '@/config/icon-registry';
import { TabBarVisibility } from '@/components/tab-bar';
export interface SnippetFontStylesheetConfig {
    /**
     * Stylesheet URL to register at document scope.
     * Omit (or set to `null`) to skip the `<link>` entirely — useful when the
     * fonts are already loaded elsewhere or when you want to rely on the CSS
     * `font-family` fallback stack.
     */
    stylesheetUrl?: string | null;
}
export interface SnippetUiFontConfig extends SnippetFontStylesheetConfig {
    /**
     * CSS font-family used by the viewer UI.
     * Defaults to `'Open Sans', system-ui, sans-serif`.
     */
    family?: string;
}
/**
 * Fonts shown in the "Type" tab of the Create Signature modal.
 * UI-only concern; not part of the signature plugin config.
 */
export interface SnippetSignatureFontConfig extends SnippetFontStylesheetConfig {
    /**
     * Font list shown in the "Type" tab's font picker.
     * Defaults to Caveat / Dancing Script / Great Vibes / Pacifico.
     */
    fonts?: Array<{
        name: string;
        family: string;
    }>;
}
/**
 * Controls the snippet's external webfont loading. Every field is opt-out:
 * omit for the built-in Google Fonts defaults, or set to `null` to skip the
 * external request and fall through to the CSS font-family fallback stack.
 */
export interface SnippetFontsConfig {
    /**
     * Stylesheet URL for the snippet UI font (Open Sans by default).
     * - `undefined`: loads Open Sans from Google Fonts at init.
     * - `null`: skip the `<link>`; the UI falls back to the system font stack.
     * - object: override the UI font family and/or stylesheet URL.
     */
    ui?: SnippetUiFontConfig | null;
    /**
     * Fonts for the "Type" tab of the Create Signature modal.
     * - `undefined`: loads the 4 cursive families from Google Fonts on first open.
     * - `null`: skip the `<link>`; typed signatures use the OS cursive stack.
     * - object: self-host / override `stylesheetUrl` and/or `fonts`.
     */
    signature?: SnippetSignatureFontConfig | null;
}
export interface PDFViewerConfig {
    /** URL or path to the PDF document. If not provided, viewer loads with no document. */
    src?: string;
    /** Use web worker for PDF processing. Default: true */
    worker?: boolean;
    /** Custom URL for the WASM file */
    wasmUrl?: string;
    /** Enable debug logging. Default: false */
    log?: boolean;
    /**
     * Font fallback configuration. Defaults to CDN fonts from jsDelivr.
     * Set to `null` to disable the fallback entirely (no external font requests).
     */
    fontFallback?: FontFallbackConfig | null;
    /**
     * Global permission configuration applied to all documents.
     * Per-document permissions (in documentManager.initialDocuments) can override these.
     *
     * @example
     * // Disable printing globally
     * permissions: { overrides: { print: false } }
     *
     * // Ignore PDF permissions entirely (allow all by default)
     * permissions: { enforceDocumentPermissions: false }
     */
    permissions?: PermissionConfig;
    /** Theme configuration */
    theme?: ThemeConfig;
    /** Custom icons */
    icons?: IconsConfig;
    /**
     * Tab bar visibility for multi-document support
     * - 'always': Always show the tab bar
     * - 'multiple': Show only when more than 1 document is open (default)
     * - 'never': Never show the tab bar
     */
    tabBar?: TabBarVisibility;
    /**
     * Globally disable features by category. This applies to both UI and commands.
     * Can be overridden by plugin-specific disabledCategories (ui.disabledCategories, commands.disabledCategories).
     *
     * Categories are hierarchical:
     * - 'annotation' - disables all annotation features
     * - 'annotation-highlight' - disables only highlight annotations
     * - 'annotation-markup' - disables highlight, underline, strikeout, squiggly
     * - 'redaction' - disables all redaction features
     * - 'zoom' - disables all zoom features
     * - 'document-print' - disables only print functionality
     *
     * @example
     * // Disable all annotation and redaction features
     * disabledCategories: ['annotation', 'redaction']
     *
     * // Disable only specific annotation types
     * disabledCategories: ['annotation-highlight', 'annotation-strikeout']
     */
    disabledCategories?: string[];
    /** Document manager options (initialDocuments) */
    documentManager?: Partial<DocumentManagerPluginConfig>;
    /** Commands options (commands, disabledCategories) */
    commands?: Partial<CommandsPluginConfig>;
    /** i18n options (defaultLocale, locales, paramResolvers) */
    i18n?: Partial<I18nPluginConfig>;
    /** UI schema options (schema, disabledCategories) */
    ui?: Partial<UIPluginConfig>;
    /** Form options (withForms, withAnnotations) */
    form?: Partial<FormPluginConfig>;
    /** Viewport options (viewportGap, scrollEndDelay) */
    viewport?: Partial<ViewportPluginConfig>;
    /** Scroll options (defaultStrategy, defaultPageGap, defaultBufferSize) */
    scroll?: Partial<ScrollPluginConfig>;
    /** Zoom options (defaultZoomLevel, minZoom, maxZoom, zoomStep) */
    zoom?: Partial<ZoomPluginConfig>;
    /** Spread/layout options (defaultSpreadMode) */
    spread?: Partial<SpreadPluginConfig>;
    /** Rotation options (defaultRotation) */
    rotation?: Partial<RotatePluginConfig>;
    /** Pan mode options (defaultMode: 'never' | 'mobile' | 'always') */
    pan?: Partial<PanPluginConfig>;
    /** Render options (withForms, withAnnotations) */
    render?: Partial<RenderPluginConfig>;
    /** Tiling options (tileSize, overlapPx, extraRings) */
    tiling?: Partial<TilingPluginConfig>;
    /** Thumbnail options (width, gap, buffer, labelHeight, etc.) */
    thumbnails?: Partial<ThumbnailPluginConfig>;
    /** Annotation options (tools, colorPresets, autoCommit, author, etc.) */
    annotations?: Partial<AnnotationPluginConfig>;
    /** Search options (flags, showAllResults) */
    search?: Partial<SearchPluginConfig>;
    /** Selection options (menuHeight) */
    selection?: Partial<SelectionPluginConfig>;
    /** Bookmark options */
    bookmarks?: Partial<BookmarkPluginConfig>;
    /** Attachment options */
    attachments?: Partial<AttachmentPluginConfig>;
    /** Capture options (scale, imageType, withAnnotations) */
    capture?: Partial<CapturePluginConfig>;
    /** Redaction options (drawBlackBoxes) */
    redaction?: Partial<RedactionPluginConfig>;
    /** Print options */
    print?: Partial<PrintPluginConfig>;
    /** Export options (defaultFileName) */
    export?: Partial<ExportPluginConfig>;
    /** Fullscreen options (targetElement) */
    fullscreen?: Partial<FullscreenPluginConfig>;
    /** Stamp options (libraries) */
    stamp?: Partial<StampPluginConfig>;
    /** Signature options (mode, default size) */
    signature?: Partial<SignaturePluginConfig>;
    /**
     * Controls external webfonts loaded by the snippet UI. See `SnippetFontsConfig`.
     * Useful for GDPR-sensitive, airgapped, or self-hosted deployments.
     */
    fonts?: SnippetFontsConfig;
    /** History/undo options */
    history?: Partial<HistoryPluginConfig>;
    /** Interaction manager options (exclusionRules) */
    interactionManager?: Partial<InteractionManagerPluginConfig>;
}
interface PDFViewerProps {
    config: PDFViewerConfig;
    onRegistryReady?: (registry: PluginRegistry) => void;
}
export declare function PDFViewer({ config, onRegistryReady }: PDFViewerProps): h.JSX.Element;
export {};
//# sourceMappingURL=app.d.ts.map