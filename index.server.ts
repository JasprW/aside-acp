import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { createAsideConnector } from "./server/connector.js";
import { withAsideHistory } from "./server/history.js";
import { withAsideSessions } from "./server/sessions.js";

export default function contribute(server: PluginServerContext) {
  const aside = createAsideConnector();
  server.registerProvider(withAsideSessions(withAsideHistory(runAcpProvider({
    id: "aside",
    label: "Aside",
    description: "Aside browser agent with your local browser profile",
    icon: "icon.svg",
    connector: aside.connect,
  }))));
  return aside.dispose;
}
