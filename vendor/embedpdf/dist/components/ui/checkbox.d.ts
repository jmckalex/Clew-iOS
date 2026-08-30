import { h } from 'preact';
interface CheckboxProps {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
}
export declare const Checkbox: ({ label, checked, onChange, disabled }: CheckboxProps) => h.JSX.Element;
export {};
//# sourceMappingURL=checkbox.d.ts.map