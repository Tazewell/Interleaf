export function devIsolation({
  isPackaged,
  env,
}: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
}) {
  return {
    userDataDirectory: isPackaged ? null : "Interleaf Dev",
    registerProtocol: isPackaged || env.INTERLEAF_DEV_PROTOCOL === "1",
    enableConnector: isPackaged || env.INTERLEAF_DEV_CONNECTOR === "1",
  };
}
