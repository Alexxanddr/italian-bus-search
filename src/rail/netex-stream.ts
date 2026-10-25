import type { Readable } from "node:stream";
import { SaxesParser } from "saxes";
import { AppError } from "../domain.ts";
import type { RailOperator } from "./provider.ts";

type Node = { name: string; attrs: Record<string, string>; text: string; children: Node[] };
export type CachedStop = { id: string; name: string };
export type CachedService = { id: string; trainNumber: string; dates: string[]; stops: Array<{ ref: string; arrival?: number; departure?: number; boarding: boolean; alighting: boolean }> };
export type TimetableCache = { operator: RailOperator; source: { source: string; publishedAt: string; validFrom: string; validThrough: string }; stops: CachedStop[]; services: CachedService[] };

const targets = new Set(["PublicationTimestamp", "StopPlace", "PassengerStopAssignment", "ServiceJourneyPattern", "Line", "DayType", "DayTypeAssignment", "UicOperatingPeriod", "OperatingPeriod", "OperatingDay", "ServiceJourney", "ValidBetween"]);

export async function parseNetexStream(stream: Readable, operator: RailOperator): Promise<TimetableCache> {
  const captured: Node[] = [], stack: Node[] = [];
  let captureDepth = 0, elementDepth = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    elementDepth += 1;
    const name = tag.name.includes(":") ? tag.name.slice(tag.name.indexOf(":") + 1) : tag.name;
    if (captureDepth === 0 && targets.has(name)) captureDepth = elementDepth;
    if (captureDepth !== 0) {
      const attrs = Object.fromEntries(Object.entries(tag.attributes).map(([key, value]) => [key.includes(":") ? key.slice(key.indexOf(":") + 1) : key, String(value)]));
      const node = { name, attrs, text: "", children: [] } satisfies Node;
      stack.at(-1)?.children.push(node); stack.push(node);
    }
  });
  parser.on("text", (value) => { if (stack.length > 0) stack.at(-1)!.text += value; });
  parser.on("cdata", (value) => { if (stack.length > 0) stack.at(-1)!.text += value; });
  parser.on("closetag", () => {
    if (captureDepth !== 0) {
      const node = stack.pop()!;
      if (elementDepth === captureDepth) { captured.push(node); captureDepth = 0; }
    }
    elementDepth -= 1;
  });
  parser.on("error", () => { throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid NeTEx XML", 502); });
  for await (const chunk of stream) parser.write(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  parser.close();

  const all = captured.flatMap((node) => [node, ...descendants(node, "*")]);
  const ranges = all.filter(({ name }) => name === "ValidBetween").map(range);
  if (ranges.length === 0) incompatible("Missing NeTEx validity");
  const publication = all.find(({ name }) => name === "PublicationTimestamp")?.text.trim();
  if (!publication) incompatible("Missing PublicationTimestamp");
  const stations = new Map(all.filter(({ name }) => name === "StopPlace").flatMap((node) => {
    const name = optionalText(node, "Name");
    return name === "" ? [] : [[requiredAttr(node, "id"), name] as const];
  }));
  const assignments = new Map(all.filter(({ name }) => name === "PassengerStopAssignment").map((node) => [requiredRef(node, "ScheduledStopPointRef"), requiredRef(node, "StopPlaceRef")]));
  const lines = new Map(all.filter(({ name }) => name === "Line").map((node) => [requiredAttr(node, "id"), optionalText(node, "PublicCode")]));
  const patterns = new Map(all.filter(({ name }) => name === "ServiceJourneyPattern").map((node) => [requiredAttr(node, "id"), { line: requiredRef(node, "LineRef"), points: descendants(node, "StopPointInJourneyPattern").sort((a, b) => Number(a.attrs.order) - Number(b.attrs.order)).map((point) => ({ id: requiredAttr(point, "id"), stop: requiredRef(point, "ScheduledStopPointRef"), boarding: bool(point, "ForBoarding"), alighting: bool(point, "ForAlighting") })) }]));
  const periods = new Map(all.filter(({ name }) => name === "UicOperatingPeriod").map((node) => {
    const [from, to] = range(node), bits = requiredText(node, "ValidDayBits"), dates = enumerate(from, to).filter((_, index) => bits[index] === "1");
    if (bits.length !== enumerate(from, to).length) incompatible("Invalid UIC calendar bits");
    return [requiredAttr(node, "id"), dates];
  }));
  const dayPeriods = new Map<string, Set<string>>();
  for (const assignment of all.filter(({ name }) => name === "DayTypeAssignment")) {
    const day = requiredRef(assignment, "DayTypeRef"), period = descendants(assignment, "OperatingPeriodRef")[0]?.attrs.ref, date = optionalText(assignment, "Date");
    const dates = dayPeriods.get(day) ?? new Set<string>();
    const selected = date ? [date.slice(0, 10)] : period && periods.has(period) ? periods.get(period)! : [];
    const available = !["false", "0"].includes(optionalText(assignment, "IsAvailable") || optionalText(assignment, "isAvailable"));
    for (const value of selected) available ? dates.add(value) : dates.delete(value);
    dayPeriods.set(day, dates);
  }
  const services: CachedService[] = [];
  for (const node of all.filter(({ name }) => name === "ServiceJourney")) {
    const pattern = patterns.get(requiredRef(node, "ServiceJourneyPatternRef"));
    if (pattern === undefined) incompatible("Unresolved journey pattern");
    const passing = new Map(descendants(node, "TimetabledPassingTime").map((time) => [requiredRef(time, "StopPointInJourneyPatternRef"), time]));
    const dayRefs = descendants(node, "DayTypeRef").map((value) => value.attrs.ref).filter(Boolean);
    const dates = [...new Set(dayRefs.flatMap((ref) => [...(dayPeriods.get(ref) ?? [])]))].sort();
    if (dates.length === 0) continue;
    let prior = 0;
    const stops = pattern.points.map((point) => {
      const time = passing.get(point.id); if (time === undefined) incompatible("Missing passing time");
      const arrival = seconds(time, "ArrivalTime", "ArrivalDayOffset", prior); if (arrival !== undefined) prior = arrival;
      const departure = seconds(time, "DepartureTime", "DepartureDayOffset", prior); if (departure !== undefined) prior = departure;
      const ref = assignments.get(point.stop); if (ref === undefined || !stations.has(ref)) incompatible(`Unresolved stop assignment: ${point.stop} -> ${ref ?? "missing"}`);
      return { ref, arrival, departure, boarding: point.boarding, alighting: point.alighting };
    });
    const lineCode = lines.get(pattern.line) ?? "";
    if (operator === "italo" && !/^\d+(?:_#\d+)?$/.test(lineCode)) continue;
    services.push({ id: requiredAttr(node, "id"), trainNumber: operator === "italo" ? lineCode.replace(/_#\d+$/, "") : optionalText(node, "PublicCode") || optionalText(node, "Name") || lineCode || requiredAttr(node, "id"), dates, stops });
  }
  if (stations.size === 0 || services.length === 0) incompatible("NeTEx dataset has no usable rail services");
  const validFrom = ranges.map(([from]) => from).sort()[0]!, validThrough = ranges.map(([, to]) => to).sort().at(-1)!;
  return { operator, source: { source: "Italian NAP NeTEx", publishedAt: publication, validFrom, validThrough }, stops: [...stations].map(([id, name]) => ({ id, name })), services };
}

function descendants(node: Node, name: string): Node[] { return node.children.flatMap((value) => [...(name === "*" || value.name === name ? [value] : []), ...descendants(value, name)]); }
function optionalText(node: Node, name: string) { const found = descendants(node, name)[0]; return found === undefined ? "" : nodeText(found).trim(); }
function nodeText(node: Node): string { return node.text + node.children.map(nodeText).join(""); }
function requiredText(node: Node, name: string) { const value = optionalText(node, name); if (!value) incompatible(`Missing ${name}`); return value; }
function requiredAttr(node: Node, name: string) { const value = node.attrs[name]; if (!value) incompatible(`Missing ${node.name}.${name}`); return value; }
function requiredRef(node: Node, name: string) { const value = descendants(node, name)[0]?.attrs.ref; if (!value) incompatible(`Missing ${name}.ref`); return value; }
function range(node: Node): [string, string] { return [requiredText(node, "FromDate").slice(0, 10), requiredText(node, "ToDate").slice(0, 10)]; }
function enumerate(from: string, to: string) { const values: string[] = []; for (let date = new Date(`${from}T00:00:00Z`); date <= new Date(`${to}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) values.push(date.toISOString().slice(0, 10)); return values; }
function bool(node: Node, name: string) { const value = optionalText(node, name); return value === "" || value === "true" || value === "1"; }
function seconds(node: Node, clockName: string, offsetName: string, prior: number) { const clock = optionalText(node, clockName); if (!clock) return undefined; const match = /^(\d{2}):([0-5]\d):([0-5]\d)$/.exec(clock); if (!match) incompatible("Invalid passing time"); let value = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(optionalText(node, offsetName) || Math.floor(prior / 86400)) * 86400; if (!optionalText(node, offsetName) && value < prior) value += 86400; return value; }
function incompatible(message: string): never { throw new AppError("INCOMPATIBLE_RESPONSE", message, 502); }
