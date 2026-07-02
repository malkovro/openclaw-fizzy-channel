// Shared runtime handle set in registerFull(api), used by inbound + outbound code.
let apiRef: any = null;

export function setApi(api: any): void {
  apiRef = api;
}

export function getApi(): any {
  if (!apiRef) throw new Error("fizzy: plugin api not initialized yet");
  return apiRef;
}
