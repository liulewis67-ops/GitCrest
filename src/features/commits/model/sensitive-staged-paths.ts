import type { StatusSnapshotResponse } from "../../../api/client";

const SENSITIVE_PATH = /(^|\/)(\.env(?:\.|$)|id_(?:rsa|dsa|ed25519)(?:$|\.)|[^/]+\.(?:pem|key|p12|pfx)|credentials(?:\.|$)|secrets?\.)/i;

export function getSensitiveStagedPaths(snapshot?: StatusSnapshotResponse): string[] {
  return (snapshot?.files ?? [])
    .filter((file) => file.categories.includes("staged") && SENSITIVE_PATH.test(file.path))
    .map((file) => file.path);
}
