/** Which app this is for the server's presence (`x-juno-client`): the Electron shell or a browser tab. */
export function appClientKind(): "web" | "desktop" {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron") ? "desktop" : "web";
}
