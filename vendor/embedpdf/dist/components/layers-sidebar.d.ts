import { h } from 'preact';
/**
 * The layers panel — a document's optional content groups.
 *
 * "Layers" is what a reader calls them and what this panel says; the engine
 * and the plugin say "optional content", because the specification does. The
 * translation happens here, at the surface, and nowhere else.
 *
 * One row is CURRENT, shown by highlighting rather than a second control. That
 * row is where new annotations go and what Delete acts on — the model every
 * layers panel uses, from Illustrator to AutoCAD.
 *
 * The tree comes from the document's own /Order when it declares one, so a CAD
 * export's grouping survives into the panel. Layers that /Order leaves out are
 * still listed underneath: a panel that hid them would misreport the file.
 */
type LayersSidebarProps = {
    documentId: string;
};
export declare function LayersSidebar({ documentId }: LayersSidebarProps): h.JSX.Element | null;
export {};
//# sourceMappingURL=layers-sidebar.d.ts.map