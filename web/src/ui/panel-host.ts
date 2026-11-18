// The panel interface the tool executor and the generated runtime use. The IWSDK implementation lives in
// panels.ts; tests use a fake.

export interface ShowPanelArgs {
  id: string;
  title?: string;
  spec?: Record<string, unknown>;
  body_uikitml?: string;
  place?: unknown;
  size?: unknown;
  /** Called with the button id instead of sending event panel_button (used by generated programs). */
  onButton?: (buttonId: string) => void;
  owner?: string;
}

export interface PanelInfo {
  id: string;
  position: number[];
  buttons: { id: string; label: string }[];
}

export interface PanelHost {
  show(args: ShowPanelArgs): Promise<PanelInfo>;
  update(id: string, patch: Record<string, unknown>): Promise<PanelInfo>;
  close(id: string): boolean;
  closeOwned(owner: string): void;
  has(id: string): boolean;
  list(): string[];
}
