# Wind fixtures

`gfs-wind-10deg.json` is NOAA's GFS 10 m wind as NOAA CoastWatch's ERDDAP server answered
`NCEP_Global_Best.json?ugrd10m[(2026-11-11T03:00:00Z)][(90):40:(-90)][(0):80:(359.5)],vgrd10m[…]`
on 2026-11-11 through the operator's browser (the build container cannot reach ERDDAP): every
20° of latitude and 40° of longitude, 90 points, the u and v of each row as served. The JSON
envelope (`columnNames`, `columnTypes`, `columnUnits`, one row a line) is written in ERDDAP's
layout from the same answer, and the time is moved from 2026-11-11T03:00Z to 2026-09-23T18:00Z
for the connector suite's fixed clock. The dataset's licence attribute reads that the data
"may be used and redistributed for free" (with a no-warranty disclaimer); GFS is a product of
NOAA's National Centers for Environmental Prediction.

`gfs-wind-empty.json` is the same envelope with no rows.
