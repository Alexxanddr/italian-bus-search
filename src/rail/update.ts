import { updateNetexDataset } from "./netex.ts";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const datasets = [
  ["trenitalia", "https://www.cciss.it/nap/mmtis/public/api/v1/download/blob/Asset/1080596/checkedResource", process.env.TRENITALIA_NETEX_PATH ?? resolve("data/trenitalia-timetable.json.gz")],
  ["italo", "https://www.cciss.it/nap/mmtis/public/api/v1/download/blob/Asset/1814124/checkedResource", process.env.ITALO_NETEX_PATH ?? resolve("data/italo-timetable.json.gz")],
] as const;

for (const [operator, source, destination] of datasets) {
  await mkdir(dirname(destination), { recursive: true });
  await updateNetexDataset(new URL(source), destination, operator);
  console.error(`Updated ${operator} timetable at ${destination}`);
}
