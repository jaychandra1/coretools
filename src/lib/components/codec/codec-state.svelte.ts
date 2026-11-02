/**
 * Codec's state for the session, kept in memory at module level so it
 * survives switching to another tool and back. Nothing typed, pasted or
 * produced is written anywhere. Only the ids of pinned tools are kept on
 * this device (local-setting.ts); "Recent" lives for the session only.
 */
import { readSetting, writeSetting } from "../../local-setting";
import { DEFAULT_OPTIONS, type CodecOptions } from "../../core/codec/run";
import { isToolId, toolById, type TabId, type ToolId } from "../../core/codec/tools";

const PINNED_KEY = "coretools.codec.pinned";
const MAX_PINNED = 8;
const MAX_RECENT = 5;

function readPinned(): ToolId[] {
  try {
    const ids = JSON.parse(readSetting(PINNED_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter(isToolId).slice(0, MAX_PINNED) : [];
  } catch {
    return [];
  }
}

/** An opened or dropped file: its bytes, and its text when it is UTF-8. */
export interface CodecFile {
  name: string;
  bytes: Uint8Array;
  text: string | null;
}

class CodecState {
  tab = $state<TabId>("encode");
  tool = $state<ToolId>("base64-encode");
  input = $state("");
  /** A file in place of the typed input. */
  file = $state<CodecFile | null>(null);
  options = $state<CodecOptions>({ ...DEFAULT_OPTIONS });
  query = $state("");
  pinned = $state<ToolId[]>(readPinned());
  recent = $state<ToolId[]>([]);
  /** The tool last used in each tab, so a tab opens where you left it. */
  lastInTab: Partial<Record<TabId, ToolId>> = {};

  select(id: ToolId) {
    this.tool = id;
    this.tab = toolById(id).tab;
    this.lastInTab[this.tab] = id;
  }

  togglePin(id: ToolId) {
    this.pinned = this.pinned.includes(id)
      ? this.pinned.filter((pinned) => pinned !== id)
      : [...this.pinned, id].slice(-MAX_PINNED);
    writeSetting(PINNED_KEY, JSON.stringify(this.pinned));
  }

  noteRecent(id: ToolId) {
    this.recent = [id, ...this.recent.filter((recent) => recent !== id)].slice(0, MAX_RECENT);
  }

  /** Secrets don't outlive the visit: passphrase and key go when Codec closes. */
  forgetSecrets() {
    this.options.passphrase = "";
    this.options.aesKey = "";
  }
}

export const codec = new CodecState();
