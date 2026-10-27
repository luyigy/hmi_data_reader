// Retired readonly reservation coverage now exercises the shared room/automatic Writer boundary.
import { normalRoomEntryRegression } from './thin-room-entry.test';
normalRoomEntryRegression({ slowWriter: true }).catch(error => { console.error(error); process.exitCode = 1; });
