"""Encode GTFS Realtime test feeds with Google's protobuf library.

The messages are declared here from gtfs-realtime.proto (google/transit @ 2ce6aa79, 2026-11-05):
the same field numbers, types and enums for the parts a vehicle map reads, and stand-ins for
TripUpdate, Alert and CarriageDetails so feeds carry fields the reader must skip.
"""
import sys
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

F = descriptor_pb2.FieldDescriptorProto
fp = descriptor_pb2.FileDescriptorProto(name='gtfs-rt-subset.proto', package='transit_realtime', syntax='proto2')

def enum(name, values, parent=None):
    e = (parent.enum_type if parent else fp.enum_type).add(name=name)
    for k, v in values:
        e.value.add(name=k, number=v)

def msg(name, fields):
    m = fp.message_type.add(name=name)
    for (fname, num, ftype, label, tname) in fields:
        f = m.field.add(name=fname, number=num, type=ftype, label=label)
        if tname:
            f.type_name = '.transit_realtime.' + tname
    return m

OPT, REQ, REP = F.LABEL_OPTIONAL, F.LABEL_REQUIRED, F.LABEL_REPEATED
enum('Incrementality', [('FULL_DATASET', 0), ('DIFFERENTIAL', 1)])
enum('VehicleStopStatus', [('INCOMING_AT', 0), ('STOPPED_AT', 1), ('IN_TRANSIT_TO', 2)])
enum('CongestionLevel', [('UNKNOWN_CONGESTION_LEVEL', 0), ('RUNNING_SMOOTHLY', 1), ('STOP_AND_GO', 2), ('CONGESTION', 3), ('SEVERE_CONGESTION', 4)])
enum('OccupancyStatus', [('EMPTY', 0), ('MANY_SEATS_AVAILABLE', 1), ('FEW_SEATS_AVAILABLE', 2), ('STANDING_ROOM_ONLY', 3), ('CRUSHED_STANDING_ROOM_ONLY', 4), ('FULL', 5), ('NOT_ACCEPTING_PASSENGERS', 6), ('NO_DATA_AVAILABLE', 7), ('NOT_BOARDABLE', 8)])
enum('TripScheduleRelationship', [('SCHEDULED', 0), ('ADDED', 1), ('UNSCHEDULED', 2), ('CANCELED', 3), ('REPLACEMENT', 5), ('DUPLICATED', 6), ('DELETED', 7), ('NEW', 8)])
enum('WheelchairAccessible', [('NO_VALUE', 0), ('UNKNOWN', 1), ('WHEELCHAIR_ACCESSIBLE', 2), ('WHEELCHAIR_INACCESSIBLE', 3)])

msg('FeedHeader', [('gtfs_realtime_version', 1, F.TYPE_STRING, REQ, None), ('incrementality', 2, F.TYPE_ENUM, OPT, 'Incrementality'), ('timestamp', 3, F.TYPE_UINT64, OPT, None), ('feed_version', 4, F.TYPE_STRING, OPT, None)])
msg('TripDescriptor', [('trip_id', 1, F.TYPE_STRING, OPT, None), ('start_time', 2, F.TYPE_STRING, OPT, None), ('start_date', 3, F.TYPE_STRING, OPT, None), ('schedule_relationship', 4, F.TYPE_ENUM, OPT, 'TripScheduleRelationship'), ('route_id', 5, F.TYPE_STRING, OPT, None), ('direction_id', 6, F.TYPE_UINT32, OPT, None)])
msg('VehicleDescriptor', [('id', 1, F.TYPE_STRING, OPT, None), ('label', 2, F.TYPE_STRING, OPT, None), ('license_plate', 3, F.TYPE_STRING, OPT, None), ('wheelchair_accessible', 4, F.TYPE_ENUM, OPT, 'WheelchairAccessible')])
msg('Position', [('latitude', 1, F.TYPE_FLOAT, REQ, None), ('longitude', 2, F.TYPE_FLOAT, REQ, None), ('bearing', 3, F.TYPE_FLOAT, OPT, None), ('odometer', 4, F.TYPE_DOUBLE, OPT, None), ('speed', 5, F.TYPE_FLOAT, OPT, None)])
msg('CarriageDetails', [('id', 1, F.TYPE_STRING, OPT, None), ('label', 2, F.TYPE_STRING, OPT, None), ('occupancy_percentage', 4, F.TYPE_INT32, OPT, None), ('carriage_sequence', 5, F.TYPE_UINT32, OPT, None)])
msg('VehiclePosition', [('trip', 1, F.TYPE_MESSAGE, OPT, 'TripDescriptor'), ('position', 2, F.TYPE_MESSAGE, OPT, 'Position'), ('current_stop_sequence', 3, F.TYPE_UINT32, OPT, None), ('current_status', 4, F.TYPE_ENUM, OPT, 'VehicleStopStatus'), ('timestamp', 5, F.TYPE_UINT64, OPT, None), ('congestion_level', 6, F.TYPE_ENUM, OPT, 'CongestionLevel'), ('stop_id', 7, F.TYPE_STRING, OPT, None), ('vehicle', 8, F.TYPE_MESSAGE, OPT, 'VehicleDescriptor'), ('occupancy_status', 9, F.TYPE_ENUM, OPT, 'OccupancyStatus'), ('occupancy_percentage', 10, F.TYPE_UINT32, OPT, None), ('multi_carriage_details', 11, F.TYPE_MESSAGE, REP, 'CarriageDetails')])
msg('TripUpdate', [('trip', 1, F.TYPE_MESSAGE, REQ, 'TripDescriptor'), ('delay', 5, F.TYPE_INT32, OPT, None)])
msg('Alert', [('cause', 6, F.TYPE_INT32, OPT, None)])
msg('FeedEntity', [('id', 1, F.TYPE_STRING, REQ, None), ('is_deleted', 2, F.TYPE_BOOL, OPT, None), ('trip_update', 3, F.TYPE_MESSAGE, OPT, 'TripUpdate'), ('vehicle', 4, F.TYPE_MESSAGE, OPT, 'VehiclePosition'), ('alert', 5, F.TYPE_MESSAGE, OPT, 'Alert')])
msg('FeedMessage', [('header', 1, F.TYPE_MESSAGE, REQ, 'FeedHeader'), ('entity', 2, F.TYPE_MESSAGE, REP, 'FeedEntity')])

pool = descriptor_pool.DescriptorPool()
pool.Add(fp)
M = {n: message_factory.GetMessageClass(pool.FindMessageTypeByName('transit_realtime.' + n)) for n in ['FeedMessage']}
FeedMessage = M['FeedMessage']

out = sys.argv[1]

def write(name, feed):
    data = feed.SerializeToString()
    open(f'{out}/{name}', 'wb').write(data)
    print(name, len(data))

f = FeedMessage()
f.header.gtfs_realtime_version = '2.0'
f.header.incrementality = 0
f.header.timestamp = 1790193595
# 1: everything a vehicle can say.
e = f.entity.add(id='v1')
v = e.vehicle
v.trip.trip_id = 'T1-1405'; v.trip.route_id = '1'; v.trip.direction_id = 1
v.trip.start_date = '20260923'; v.trip.start_time = '14:05:00'; v.trip.schedule_relationship = 0
v.vehicle.id = '1801'; v.vehicle.label = 'Bus 1801'; v.vehicle.license_plate = 'MA 1801'; v.vehicle.wheelchair_accessible = 2
v.position.latitude = 42.3601; v.position.longitude = -71.0589; v.position.bearing = 90; v.position.speed = 8.5
v.position.odometer = 123456.75
v.current_stop_sequence = 5; v.stop_id = 'place-dwnxg'; v.current_status = 1
v.timestamp = 1790193585; v.congestion_level = 1; v.occupancy_status = 1; v.occupancy_percentage = 30
# 2: the least a vehicle can be: its entity id and a position; the header's time.
e = f.entity.add(id='v2')
e.vehicle.position.latitude = -33.8688; e.vehicle.position.longitude = 151.2093
# 3: a trip update: skipped.
e = f.entity.add(id='tu1'); e.trip_update.trip.trip_id = 'T9'; e.trip_update.delay = 120
# 4: deleted: skipped.
e = f.entity.add(id='v3', is_deleted=True)
e.vehicle.position.latitude = 1; e.vehicle.position.longitude = 1
# 5: an alert: skipped.
e = f.entity.add(id='alert1'); e.alert.cause = 7
# 6: carriages (a field the reader does not take) and a trip added outside the schedule.
e = f.entity.add(id='v4')
v = e.vehicle
v.vehicle.id = 'T-22'; v.vehicle.label = 'Train 22'
v.position.latitude = 59.9139; v.position.longitude = 10.7522; v.position.bearing = 270.5
v.trip.route_id = 'L1'; v.trip.schedule_relationship = 8
c = v.multi_carriage_details.add(id='c1', label='A', occupancy_percentage=55, carriage_sequence=1)
v.multi_carriage_details.add(id='c2', label='B', occupancy_percentage=-1, carriage_sequence=2)
v.timestamp = 1790193550
write('vehicles.pb', f)

g = FeedMessage(); g.header.gtfs_realtime_version = '2.0'; g.header.timestamp = 1790193595
write('empty.pb', g)
# Only trip updates: a feed of no vehicles.
t = FeedMessage(); t.header.gtfs_realtime_version = '2.0'
e = t.entity.add(id='tu1'); e.trip_update.trip.trip_id = 'T9'
write('trip-updates-only.pb', t)
