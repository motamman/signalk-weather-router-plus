# The sailing search on the mesh

Status: approved 2026-10-08. Steps 1 to 5 written and tested (372 tests);
deployed to brain the same evening, awaiting the owner's run and the exact
check of its legs against the mesh (step 3's measurement).

## The problem

The mesh holds the chart: charted depth, bridge clearance, rocks, marks,
structures. Today only the motoring route is found on it. The sailing
search that plans the open stretches between narrow passages never sees
the mesh. It checks its moves against the coastline only, so it crosses
shoals (job 20e5c6ef: 2 m water off Monomoy, waypoints on the shoal).

The mesh is too big to hold in the route worker (1.1 to 1.6 GB on brain
for a leg's box), so it lives in a helper process that reads it, finds the
motoring route and exits. The sailing search runs in the worker.

The 22 m grid built on 2026-10-08 to pass the blocked triangles to the
worker is a shortcut and is removed by this plan.

## The fix

Run the whole mesh leg in the helper, next to the mesh: the motoring
route, the split into narrow and open stretches, the sailing search of the
open stretches, the tack layout, the polish, and the stitching. Every move
the search considers is tested by walking the mesh triangles it crosses
and stopping at the first one the boat cannot use. That is the test the
motoring route is built with. No copy of the chart, no grid.

The helper returns the finished leg to the worker. The worker does what it
does today for everything else: legs outside a mesh, the Signal K route,
the GeoJSON, the log.

## What the helper needs, and where it gets it

| Need | Today | In the helper |
|---|---|---|
| The mesh | read from tiles | unchanged |
| Wind and waves | the worker reads a window of the decoded run on disk | the helper reads the same window from the same files |
| Regional wind (AROME etc.) | decoded runs on disk, layered over ECMWF | the helper reads the same runs; the worker tells it which |
| Currents: RTOFS | GRIB files in the plugin's cache | the helper reads the cached files for the leg's box |
| Currents: SMOC | chunks in the plugin's cache, fetched on demand by the worker | the worker fetches the leg's box first, as now; the helper reads the chunks |
| Currents: harmonics | files | the helper reads the files |
| Polar | a file, scaled, floored | the worker sends the numbers |
| Vessel, mode, threshold, limits, search preset, router, avoid areas | the worker | sent with the task |

The helper never uses the network.

## The land test on the mesh

One object answers the four questions the search asks today of the land
mask: is this point usable, does this straight move cross something the
boat cannot use, the same two exactly and in bulk.

- A point: the triangle under it, blocked or not. Found through a grid of
  the triangles' positions built once per leg (the tile scan used today is
  too slow for thousands of candidates a stage).
- A move: walk from the triangle under the start along the move, triangle
  to triangle, and stop at the first blocked one (the walk that already
  measures passage widths).
- Outside the mesh: not usable.

Blocked means what it means for the motoring route: depth under draught +
0.5 m off a fairway, clearance under air draft + 1 m, a rock or wreck
shallower than that or uncharted, a mark, a structure, an area to avoid.

## Depth under each waypoint

Read from the triangle under the waypoint in the helper. A waypoint on a
depth contour (a corner of the mesh route, shared by a usable and a blocked
triangle) reports the usable triangle's depth.

## Progress and cancel

The helper streams its progress lines to the worker as they happen (today
it sends one answer at the end), so the log and the stage fronts show as
now. Cancel kills the helper, as now.

## What goes

- `src/engine/mesh/raster.ts`, `src/geo/blockedraster.ts`, `withOverlay`
  in `landmask.ts`, the `blocked` field of the mesh result, their tests.
- The `mesh-depths` task (depth is read in the helper with the leg).

## What stays

- The hybrid rule (narrow passages along the mesh route, open stretches
  searched), the mesh route as the search's guide line, the sail-only
  rule, the funnel fix, the box widening.

## Steps, each tested, each deployed and run on brain before the next

1. The mesh land test (point, move, bulk) with its triangle grid. Tests
   on the small meshes the mesh tests use.
2. The helper loads wind, currents and polar from disk for a leg. Test on
   brain: the same leg planned in the worker and in the helper with the
   grid removed gives the same route.
3. The mesh leg runs in the helper with the mesh land test. Grid removed.
   Run Block Island to the canal; walk every leg of the result through
   the mesh with the exact check; measure the helper's memory and time.
4. Depth under waypoints from the helper.
5. Docs: README, CHANGELOG, WHATSNEW.

## Not measured

- The helper's memory with the search's arrays, the currents and the
  forecast window on top of the mesh (the mesh alone: 1.1 to 1.6 GB on
  brain). Measured in step 3 before anything is called done.
- The time of the triangle walk for a maximum search (16,000 candidates a
  stage on 2026-10-08). Measured in step 3.
