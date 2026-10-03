# Asset licences

Every non-procedural (externally-sourced) art asset in this repo must have an entry here:
source, author, licence, and commercial-use status. This is miserable to reconstruct after the
fact — see docs/ARCHITECTURE.md's "Art direction" — so it is committed alongside the asset, not
written up after the fact.

Status legend:
- **CONFIRMED** — licence text read directly from the authoritative source (not just embedded
  metadata) by a human on this team, on this date.
- **LIKELY OK, NOT YET CONFIRMED BY A HUMAN** — strong automated evidence (embedded file
  metadata, cross-checked against the live source page), but no human has read the licence terms
  and made the final call. Treat as **UNVERIFIED for release purposes** until someone does.

---

## Deck crew figure (`crew-01`)

| field | value |
|---|---|
| asset | `packages/assets-pipeline/raw/bikini_girl.glb` → `apps/client/public/models/crew/crew-01.lod{0,1}.glb` |
| title | "Bikini girl" |
| author | doublesob ([sketchfab.com/ssorpeg](https://sketchfab.com/ssorpeg)) |
| source | <https://sketchfab.com/3d-models/bikini-girl-95aba54a1796409ea85285c5a841b9a5> |
| licence (as recorded) | CC-BY-4.0 (<http://creativecommons.org/licenses/by/4.0/>) |
| commercial use | Permitted under CC-BY-4.0, **conditional on attribution**. |
| **status** | **LIKELY OK, NOT YET CONFIRMED BY A HUMAN — must be confirmed before any public/Steam release.** |

### Why this isn't marked CONFIRMED

The licence/author/source fields above were **not manually typed in by a human reviewer** — they
were extracted two ways, which agree with each other but are still both automated:

1. The GLB's own `asset.extras` block (readable with any glTF/JSON viewer) embeds:
   `{"author":"doublesob (https://sketchfab.com/ssorpeg)","license":"CC-BY-4.0 (...)","source":"https://sketchfab.com/3d-models/bikini-girl-95aba54a1796409ea85285c5a841b9a5","title":"Bikini girl"}`.
2. An automated fetch of the live Sketchfab page (2026-10-03) returned the same licence
   ("CC Attribution") and the same author handle.

That agreement is reassuring but **does not substitute for a human reading Sketchfab's actual
licence terms and this project's own attribution requirements** — metadata can be wrong, pages
change, and "CC-BY" has specific attribution-format obligations (credit text, link-back) that
need to actually be implemented somewhere (credits screen / README) before this is shippable.

**TODO before any public/Steam build:**
1. A human opens the source URL above and confirms the licence shown is still CC-BY-4.0.
2. Add the required attribution ("Bikini girl" by doublesob, CC-BY-4.0, link to the Sketchfab
   page) to the game's credits screen — CC-BY requires attribution to remain discoverable by end
   users, not just in a repo doc.
3. Re-run this check for every additional crew figure/texture added later — each one gets its own
   row in this table, not a blanket assumption that "the pipeline already checked licences."
4. The two textures (`baseColorTexture`, `normalTexture`) ship inside the same GLB and are
   assumed to be covered by the same Sketchfab licence grant as the mesh (that's the normal case
   for a single-model Sketchfab upload) — not independently verified.

### Technical notes

- Not rigged: `skins: 0, animations: 0` in the source file. Static pose only — see
  `apps/client/src/entities/crew-model/index.ts` for what adding a rigged+animated version later
  requires.
- Original: glTF 2.0, Sketchfab-17.3.0 export, 49,860 triangles, 1 mesh / 1 material / 2 textures
  (1024×1024 baseColor + normal, PNG), 4.71 MB.
- Pipeline output (see `packages/assets-pipeline/scripts/build-crew.sh` and this project's
  report for exact numbers): two LODs, simplified with `@gltf-transform/cli` (meshoptimizer
  simplifier) + meshopt geometry compression + WebP textures. KTX2/Basis was tried first and built
  cleanly (valid glTF, `gltf-transform validate` reported zero errors), but its Basis transcoder
  runs inside a Web Worker and that worker's WASM init never completed in this project's
  sandboxed/software-WebGL test environment — figures loaded with zero errors but never visually
  appeared. WebP has no such runtime dependency and, empirically, compressed *smaller* for this
  asset besides. See `build-crew.sh`'s header for the full explanation.

### Mixamo animation (not used by this pipeline)

`Hip Hop Dancing.fbx` (in the user's Downloads, not copied into this repo) is a Mixamo library
animation with a standard `mixamorig:` skeleton. Mixamo's own licence (free for use, including
commercial, per Adobe's Mixamo ToS as of this writing — **also not independently confirmed by a
human on this team**) is separate from the character model's CC-BY licence above and would need
its own row here if/when it's actually brought into the repo.
