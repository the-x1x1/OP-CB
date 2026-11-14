/**
 * GTFS Realtime (the `gtfs-realtime.proto` of google/transit, read 2026-11-10 at
 * 2ce6aa79): the FeedMessage's vehicle positions, decoded from protobuf wire format without a
 * dependency. Only what a map of moving vehicles needs is read — the header, and each entity's
 * `vehicle` (VehiclePosition: trip, vehicle, position, stop, status, timestamp, congestion,
 * occupancy). Trip updates, alerts, shapes and every field not named here are skipped by wire
 * type, as protobuf readers do, so a feed carrying them still reads.
 *
 * A record keeps the proto's own field names (snake_case), with enums as their names
 * (`IN_TRANSIT_TO`, not 2); a field the feed left out is left out. 64-bit integers are read as
 * numbers (timestamps and odometers stay well inside 2^53).
 */

export interface GtfsRealtimeFeed {
  header: { gtfs_realtime_version?: string; incrementality?: string; timestamp?: number; feed_version?: string };
  /** One per FeedEntity that has a `vehicle` and is not deleted. */
  vehicles: GtfsRealtimeVehicleRecord[];
  /** Entities in the feed, of any kind. */
  entities: number;
}

export interface GtfsRealtimeVehicleRecord {
  id: string;
  /** The header's timestamp, for vehicles that carry none of their own. */
  feedTimestamp?: number;
  vehicle: Record<string, unknown>;
}

const INCREMENTALITY = ['FULL_DATASET', 'DIFFERENTIAL'];
const VEHICLE_STOP_STATUS = ['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO'];
const CONGESTION_LEVEL = [
  'UNKNOWN_CONGESTION_LEVEL',
  'RUNNING_SMOOTHLY',
  'STOP_AND_GO',
  'CONGESTION',
  'SEVERE_CONGESTION',
];
const OCCUPANCY_STATUS = [
  'EMPTY',
  'MANY_SEATS_AVAILABLE',
  'FEW_SEATS_AVAILABLE',
  'STANDING_ROOM_ONLY',
  'CRUSHED_STANDING_ROOM_ONLY',
  'FULL',
  'NOT_ACCEPTING_PASSENGERS',
  'NO_DATA_AVAILABLE',
  'NOT_BOARDABLE',
];
/** TripDescriptor.ScheduleRelationship (not StopTimeUpdate's): 4 is unused in the proto. */
const TRIP_SCHEDULE_RELATIONSHIP: Record<number, string> = {
  0: 'SCHEDULED',
  1: 'ADDED',
  2: 'UNSCHEDULED',
  3: 'CANCELED',
  5: 'REPLACEMENT',
  6: 'DUPLICATED',
  7: 'DELETED',
  8: 'NEW',
};
const WHEELCHAIR_ACCESSIBLE = ['NO_VALUE', 'UNKNOWN', 'WHEELCHAIR_ACCESSIBLE', 'WHEELCHAIR_INACCESSIBLE'];

/** Feeds of whole cities run to tens of thousands of entities; more than this is not a feed. */
export const GTFS_RT_MAX_ENTITIES = 200_000;

export class GtfsRealtimeError extends Error {}

/** A cursor over one length-delimited message. */
class Reader {
  pos: number;
  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new GtfsRealtimeError('truncated varint');
      const b = this.buf[this.pos++]!;
      // Multiplication, not <<: the shifts past 31 bits would wrap.
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
    }
    throw new GtfsRealtimeError('varint longer than 10 bytes');
  }

  /** A tag: field number and wire type. */
  tag(): { field: number; wire: number } {
    const t = this.varint();
    const field = Math.floor(t / 8);
    if (field < 1) throw new GtfsRealtimeError('field number 0');
    return { field, wire: t % 8 };
  }

  private take(n: number): number {
    if (n < 0 || this.pos + n > this.end) throw new GtfsRealtimeError('field runs past the end of its message');
    const at = this.pos;
    this.pos += n;
    return at;
  }

  float32(): number {
    const at = this.take(4);
    return new DataView(this.buf.buffer, this.buf.byteOffset + at, 4).getFloat32(0, true);
  }

  float64(): number {
    const at = this.take(8);
    return new DataView(this.buf.buffer, this.buf.byteOffset + at, 8).getFloat64(0, true);
  }

  /** The bounds of a length-delimited field. */
  delimited(): { start: number; end: number } {
    const n = this.varint();
    const start = this.take(n);
    return { start, end: start + n };
  }

  string(): string {
    const { start, end } = this.delimited();
    return new TextDecoder('utf-8', { fatal: false }).decode(this.buf.subarray(start, end));
  }

  sub(): Reader {
    const { start, end } = this.delimited();
    return new Reader(this.buf, start, end);
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.take(8);
        return;
      case 2:
        this.delimited();
        return;
      case 5:
        this.take(4);
        return;
      default:
        // 3 and 4 are proto2 groups, which GTFS Realtime does not use; 6 and 7 do not exist.
        throw new GtfsRealtimeError(`wire type ${wire} (not used by GTFS Realtime)`);
    }
  }
}

function expect(r: Reader, wire: number, want: number, what: string): void {
  if (wire !== want) throw new GtfsRealtimeError(`${what} has wire type ${wire}, not ${want}`);
}

const enumName = (names: readonly string[] | Record<number, string>, n: number): string =>
  (names as Record<number, string>)[n] ?? String(n);

/** Fields of one message, read with `read(field, wire)`; anything it does not take is skipped. */
function eachField(r: Reader, read: (field: number, wire: number) => boolean): void {
  while (!r.done) {
    const { field, wire } = r.tag();
    if (!read(field, wire)) r.skip(wire);
  }
}

function readHeader(r: Reader): GtfsRealtimeFeed['header'] {
  const h: GtfsRealtimeFeed['header'] = {};
  eachField(r, (field, wire) => {
    if (field === 1 && wire === 2) h.gtfs_realtime_version = r.string();
    else if (field === 2 && wire === 0) h.incrementality = enumName(INCREMENTALITY, r.varint());
    else if (field === 3 && wire === 0) h.timestamp = r.varint();
    else if (field === 4 && wire === 2) h.feed_version = r.string();
    else return false;
    return true;
  });
  return h;
}

function readTrip(r: Reader): Record<string, unknown> {
  const t: Record<string, unknown> = {};
  eachField(r, (field, wire) => {
    if (field === 1 && wire === 2) t['trip_id'] = r.string();
    else if (field === 2 && wire === 2) t['start_time'] = r.string();
    else if (field === 3 && wire === 2) t['start_date'] = r.string();
    else if (field === 4 && wire === 0) t['schedule_relationship'] = enumName(TRIP_SCHEDULE_RELATIONSHIP, r.varint());
    else if (field === 5 && wire === 2) t['route_id'] = r.string();
    else if (field === 6 && wire === 0) t['direction_id'] = r.varint();
    else return false;
    return true;
  });
  return t;
}

function readVehicleDescriptor(r: Reader): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  eachField(r, (field, wire) => {
    if (field === 1 && wire === 2) v['id'] = r.string();
    else if (field === 2 && wire === 2) v['label'] = r.string();
    else if (field === 3 && wire === 2) v['license_plate'] = r.string();
    else if (field === 4 && wire === 0) v['wheelchair_accessible'] = enumName(WHEELCHAIR_ACCESSIBLE, r.varint());
    else return false;
    return true;
  });
  return v;
}

function readPosition(r: Reader): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  eachField(r, (field, wire) => {
    if (field === 1) (expect(r, wire, 5, 'latitude'), (p['latitude'] = r.float32()));
    else if (field === 2) (expect(r, wire, 5, 'longitude'), (p['longitude'] = r.float32()));
    else if (field === 3 && wire === 5) p['bearing'] = r.float32();
    else if (field === 4 && wire === 1) p['odometer'] = r.float64();
    else if (field === 5 && wire === 5) p['speed'] = r.float32();
    else return false;
    return true;
  });
  return p;
}

function readVehiclePosition(r: Reader): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  eachField(r, (field, wire) => {
    if (field === 1 && wire === 2) v['trip'] = readTrip(r.sub());
    else if (field === 2 && wire === 2) v['position'] = readPosition(r.sub());
    else if (field === 3 && wire === 0) v['current_stop_sequence'] = r.varint();
    else if (field === 4 && wire === 0) v['current_status'] = enumName(VEHICLE_STOP_STATUS, r.varint());
    else if (field === 5 && wire === 0) v['timestamp'] = r.varint();
    else if (field === 6 && wire === 0) v['congestion_level'] = enumName(CONGESTION_LEVEL, r.varint());
    else if (field === 7 && wire === 2) v['stop_id'] = r.string();
    else if (field === 8 && wire === 2) v['vehicle'] = readVehicleDescriptor(r.sub());
    else if (field === 9 && wire === 0) v['occupancy_status'] = enumName(OCCUPANCY_STATUS, r.varint());
    else if (field === 10 && wire === 0) v['occupancy_percentage'] = r.varint();
    else return false;
    return true;
  });
  return v;
}

/**
 * Decode a FeedMessage. Throws GtfsRealtimeError on bytes that are not one (a web page, a
 * truncated download), so the caller can report the answer as malformed.
 */
export function decodeGtfsRealtime(bytes: Uint8Array): GtfsRealtimeFeed {
  if (bytes.length === 0) throw new GtfsRealtimeError('empty body');
  // A FeedMessage starts with its header (field 1, length-delimited: 0x0a) in every encoder;
  // an HTML page or JSON error starts with '<' or '{'.
  if (bytes[0] === 0x3c || bytes[0] === 0x7b) throw new GtfsRealtimeError('the body is text, not a protobuf feed');
  const r = new Reader(bytes);
  let header: GtfsRealtimeFeed['header'] | undefined;
  const vehicles: GtfsRealtimeVehicleRecord[] = [];
  let entities = 0;
  eachField(r, (field, wire) => {
    if (field === 1) {
      expect(r, wire, 2, 'header');
      header = readHeader(r.sub());
      return true;
    }
    if (field !== 2) return false;
    expect(r, wire, 2, 'entity');
    if (++entities > GTFS_RT_MAX_ENTITIES) throw new GtfsRealtimeError(`more than ${GTFS_RT_MAX_ENTITIES} entities`);
    const e = r.sub();
    let id: string | undefined;
    let deleted = false;
    let vehicle: Record<string, unknown> | undefined;
    eachField(e, (f, w) => {
      if (f === 1 && w === 2) id = e.string();
      else if (f === 2 && w === 0) deleted = e.varint() !== 0;
      else if (f === 4 && w === 2) vehicle = readVehiclePosition(e.sub());
      else return false;
      return true;
    });
    if (id !== undefined && vehicle && !deleted) vehicles.push({ id, vehicle });
    return true;
  });
  if (!header) throw new GtfsRealtimeError('no FeedHeader');
  if (!header.gtfs_realtime_version) throw new GtfsRealtimeError('the FeedHeader has no gtfs_realtime_version');
  if (header.timestamp !== undefined) for (const v of vehicles) v.feedTimestamp = header.timestamp;
  return { header, vehicles, entities };
}
