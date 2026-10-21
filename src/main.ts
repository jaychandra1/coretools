import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { bootstrapVault } from "./lib/vault-bootstrap";
import { purgeExpiredSession } from "./lib/core/json-studio/db";

// Every vault collection is registered before any UI can touch the vault.
bootstrapVault();
void purgeExpiredSession(); // JSON-Studio's recovery copy expires even unopened

const target = document.getElementById("app");
if (!target) throw new Error("Root element #app not found");

const app = mount(App, { target });

export default app;
