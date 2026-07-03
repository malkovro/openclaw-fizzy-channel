let apiRef = null;
function setApi(api) {
  apiRef = api;
}
function getApi() {
  if (!apiRef) throw new Error("fizzy: plugin api not initialized yet");
  return apiRef;
}
export {
  getApi,
  setApi
};
