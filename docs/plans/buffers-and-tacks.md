# Buffers, the tacking penalty, the minimum sailing speed on the Plan tab

Status: approved 2026-10-08. Items 1 to 4 written and tested; 2 awaits
2 done, default 30 s (the golden beat fixture re-recorded); 3 done with
a known gap left on purpose: the growth is a single nearest-first flood
(8 to 17 s per leg at 50 to 300 m on brain) that misses 0.1 to 0.5% of the
triangles within the buffer; the exact per-edge walk (26 to 207 s) is
described in `growBlocked`'s comment as the alternative; 4's coastline
part done, its mesh-edge part not started.

Four things the owner asked for on 2026-10-08. Each is one change, written
after a go for that one, tested, deployed and run on brain, then stopped.

## What exists today (checked 2026-10-08)

- No land buffer and no navigable-water buffer anywhere: the only standoffs
  are inside the mesh build (20 m round marks) and the depth rule (draught
  + 0.5 m).
- The tacking penalty is a constant, 30 s per tack, in the refined router's
  layout (`TACK_PENALTY_S`, `src/engine/experimental/propagator.ts`). The
  standard router charges nothing for a tack. There is no setting.
- The minimum sailing speed is the "Min sail speed" slider on the Route
  tab's Options sub-tab (Sailing strategy), sent as `sail_thresh_ms`.

## 1. Minimum sailing speed on the Plan sub-tab

What you see: the slider moves from Options → Sailing strategy to Plan,
beside Method, Router and Smoothing. Same control, same request field,
remembered per browser as now; the Defaults value is the starting point.

Code: `public/index.html`, `public/rp-plan.js`. No engine change. Tests:
the web app's existing checks of the request body.

## 2. Tacking penalty

What you see: Defaults → Sailing strategy → "Tacking penalty", a time (your
Signal K time unit), stored in seconds. Default 30 s, which is what the
refined router charges today, so nothing changes until you set it.

What it does: every tack or gybe costs that many seconds, in both routers.

- Standard router: in the search, a move whose heading is on the other
  tack from its parent's (the true wind angle changes sign, both sailing)
  has the penalty added to its time and its cost, so a branch that tacks
  arrives later and ranks lower. The final beat to the destination (two
  tacks) charges it once. Code: `src/engine/search/propose.ts`,
  `terminal.ts`; the candidate already carries its heading.
- Refined router: the layout's constant becomes the setting
  (`experimental/propagator.ts`); the search it runs on the hull charges
  as the standard router does.
- The setting travels with the request's simulation options (`sim`), so
  the mesh helper gets it too.

What it does not do: the zigzag round a shoal (legs 68 to 70 of job
1899de7a) is not a tack; the penalty will not remove it. That needs a
polish that tries one detour point, planned separately if wanted.

Tests: a dead-upwind leg with penalty 0 and 600 s: the route with the
penalty has fewer tacks and a later arrival that includes them; the
standard router's beat charges once.

## 3. Navigable-water buffer (mesh legs)

What you see: Defaults → "Buffer from unusable water", a distance (your
Signal K length unit), stored in metres. Default 0.

What it does: on a mesh leg the boat keeps at least that far from every
triangle it cannot use (charted depth under the draught + 0.5 m, clearance
under the air draft + 1 m, rocks, wrecks, marks, structures, areas to
avoid). Once per leg, in the mesh helper, the blocked set is grown: a
breadth-first walk from every blocked triangle across shared edges marks
each usable triangle whose nearest point to a blocked one is within the
buffer. Everything then uses the grown set: the mesh route (A* and
funnel), the passage widths, the narrow/open split, the search's moves,
the tack layout, the polish, the smoother. So the motoring route keeps the
buffer too, and the sailed stretches with it.

Consequences, stated so they are not surprises:

- A passage narrower than twice the buffer closes. The mesh search then
  finds no route or widens its box; the log says the buffer closed it when
  the same leg routes with the buffer at 0.
- A start or end point inside the grown set is refused with the distance
  to the nearest blocked triangle, not moved.
- Cost: the walk visits the triangles near every blocked edge. With
  triangles of 20 to 100 m and a 100 m buffer that is a few rings; with a
  500 m buffer in shoal-strewn water it is many. Measured on brain on the
  Block Island to canal leg at 0, 50, 100 and 300 m before it is called
  done; the time goes in the log line.

Code: `src/engine/mesh/route.ts` (grow after `blockedTriangles`), the
setting in `settings.ts`, `config.ts`, the request's `sim`. Tests: a grid
mesh with one blocked column: with the buffer at 150 m the cells either
side are blocked too; a 400 m channel between two blocked columns closes
at a 250 m buffer and stays open at 150 m; a route through it fails with
the distance in the reason.

## 4. Land buffer (coastline)

What you see: Defaults → "Buffer from land", a distance, stored in metres.
Default 0.

What it does: on a coastline leg (no mesh), the boat keeps at least that
far from the coastline. The land raster is grown by the buffer (every cell
within it of a land cell counts as land; the local finer patches too), and
the exact polygon test counts a point within the buffer of a shoreline
edge as land and a move that comes within the buffer of one as crossing
land. So the search, the smoother and the final validation all keep it.
On a mesh leg the mesh's edge is the coast (the mesh has no triangles on
land), and the same buffer grows the unusable set from that edge, with the
walk of item 3.

Consequences:

- The start and end points: today a point within 150 m of the shore is
  moved to the nearest water with 150 m round it. With a buffer above
  150 m the buffer is the clearance used for that move, and the log says
  so.
- Passages narrower than twice the buffer close, including the water
  grid's narrow passages used for the corridor; the corridor search reports
  it and the route fails naming the passage, as it does today when a
  passage is blocked.
- Cost: growing the raster is a pass over the leg's raster per cell of
  buffer width (a 25 M cell raster, buffer of 3 cells: three passes, not
  measured); the exact test's edge loop gains a distance test with the
  same bounding-box filter. Measured on brain on a coastline leg (Newport
  to Block Island) at 0, 100 and 300 m.

Code: `src/geo/landmask.ts` (grow, distance tests), the stop snapping in
`src/plugin/worker/route.ts`, the settings. Tests: the land mask's unit
tests with a buffer; the pipeline test of a channel that closes.

## Order

1, 2, 3, 4: the smallest first; the mesh buffer before the coastline one
because the mesh is where the question came up and its growth is simpler
(triangles, not raster cells and polygons). Each with its own go.

## Not measured

Every cost above. Measured on brain per item, before "done".
