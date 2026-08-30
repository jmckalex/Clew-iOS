import { h } from 'preact';
/**
 * "Which layer is this annotation on?" — a dropdown hanging off the layers
 * button in the annotation selection menu.
 *
 * A popover rather than a side panel on purpose. Opening a sidebar re-lays out
 * the whole workspace, which moves the page under the annotation the reader is
 * pointing at; for a one-shot choice that is far too much furniture.
 *
 * The selection is captured when the menu OPENS, not read again when a row is
 * clicked. Both matter: a click anywhere outside the page can clear the
 * selection, and if the picker's own row disappeared on mousedown the click
 * would never complete — which is exactly how the panel this replaces failed.
 */
type Props = {
    documentId: string;
};
export declare function AnnotationLayerMenu({ documentId }: Props): h.JSX.Element | null;
export {};
//# sourceMappingURL=annotation-layer-menu.d.ts.map