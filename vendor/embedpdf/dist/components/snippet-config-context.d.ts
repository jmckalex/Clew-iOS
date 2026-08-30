import { h, ComponentChildren } from 'preact';
import type { PDFViewerConfig } from './app';
interface SnippetConfigProviderProps {
    config: PDFViewerConfig;
    children: ComponentChildren;
}
export declare function SnippetConfigProvider({ config, children }: SnippetConfigProviderProps): h.JSX.Element;
export declare function useSnippetConfig(): PDFViewerConfig;
export {};
//# sourceMappingURL=snippet-config-context.d.ts.map