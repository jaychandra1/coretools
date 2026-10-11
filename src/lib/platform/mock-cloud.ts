// TEMPORARY verification fake — delete before committing.
import type { CloudBridge } from "./types";
import type { RemoteBackup } from "../core/authenticator/cloud-sync";
import { md5Hex } from "../core/authenticator/cloud-sync";

type Stored = RemoteBackup & { content: string };
const files: Stored[] = [];
let connected = false;
let clock = Date.now();
(window as unknown as { __mockCloud: unknown }).__mockCloud = { files, fail: { next: "" } };
const fail = (window as unknown as { __mockCloud: { fail: { next: string } } }).__mockCloud.fail;

function maybeFail() {
  if (fail.next) {
    const token = fail.next;
    fail.next = "";
    throw token;
  }
}

export const mockCloud: CloudBridge = {
  async available() {
    return true;
  },
  async status() {
    return connected ? { email: "tester@example.com", deviceName: "DEV-PC" } : null;
  },
  async connect() {
    await new Promise((r) => setTimeout(r, 400));
    connected = true;
    return { email: "tester@example.com", deviceName: "DEV-PC" };
  },
  async cancelConnect() {},
  async disconnect() {
    connected = false;
  },
  async list() {
    maybeFail();
    return files.map(({ content: _c, ...meta }) => meta);
  },
  async upload(file) {
    maybeFail();
    clock += 60_000;
    const stored: Stored = {
      id: `f${files.length + 1}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      createdTime: new Date(clock).toISOString(),
      size: file.content.length,
      md5Checksum: md5Hex(file.content),
      deviceId: file.deviceId,
      deviceLabel: file.deviceLabel,
      content: file.content,
    };
    files.push(stored);
    const { content: _c, ...meta } = stored;
    return meta;
  },
  async download(id) {
    maybeFail();
    const f = files.find((x) => x.id === id);
    if (!f) throw "cloud_not_found";
    return f.content;
  },
  async remove(id) {
    const i = files.findIndex((x) => x.id === id);
    if (i >= 0) files.splice(i, 1);
  },
};
