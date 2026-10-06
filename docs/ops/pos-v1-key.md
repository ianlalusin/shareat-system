# The v2 POS key — steps for Ian (row 279, T-375 Q1)

Ian ruled (bible row 279): **a new, store-scoped POS API key for v2**; v1's global key is not reused. Nothing can be
linked on production until this exists. The key's value never goes in chat, a commit, or a doc.

**How POS checks it** (`POS/src/lib/server/external-auth.ts:29-67`): a key in `POS_EXTERNAL_API_KEYS_JSON`, a JSON
map `{ "<key>": ["<POS store id>", ...] }`, may only query the stores listed. A store not in the list gets **403**.
POS today declares only the global `POS_EXTERNAL_API_KEY` in `apphosting.yaml:36`, so step 2 adds the map.
POS is `https://shareat--shareat-hub-v2.asia-southeast1.hosted.app` (Firebase App Hosting, backend `shareat`,
project `shareat-hub-v2`; v1 reads the same URL, `ERP-rebuild/apphosting.yaml:26-27`).

## 1. Make the key (your laptop, Git Bash)
```bash
openssl rand -hex 32
```
Keep it in your password manager as "POS key for ERP v2".

## 2. Give it to POS (the POS repo, your side)
1. The POS store ids (Firestore ids) of the stores v2 may read. Lipa is `L5MExycvUOfQ96Y10FqF`; the others are in POS
   admin → Stores. List every store you intend to link, so the key need not be rotated store by store.
2. Store the map as a secret (paste the JSON when it prompts): `{"<the key>":["L5MExycvUOfQ96Y10FqF","<id2>"]}`
   ```bash
   firebase apphosting:secrets:set POS_EXTERNAL_API_KEYS_JSON --project shareat-hub-v2
   ```
   Answer **yes** when it offers to grant the `shareat` backend access.
3. Add to POS `apphosting.yaml`, under `env:` next to `POS_EXTERNAL_API_KEY`:
   ```yaml
     - variable: POS_EXTERNAL_API_KEYS_JSON
       secret: POS_EXTERNAL_API_KEYS_JSON
       availability:
         - RUNTIME
   ```
4. Commit and roll out POS as usual. v1 keeps its global key and is unaffected.

## 3. Give it to v2 (production, `159.223.46.224` only)
Add two lines to `/srv/shareat-shared/.env.local` (edit with `nano`; never echo the key in a command):
```
POS_API_URL=https://shareat--shareat-hub-v2.asia-southeast1.hosted.app
POS_API_KEY=<the key>
```
then `systemctl restart shareat-erp` and check `https://erp2.shareat.net/sign-in` returns 200.

## 4. Prove it (no key on screen)
```bash
ssh root@159.223.46.224 'E=/srv/shareat-shared/.env.local; K=$(grep -m1 "^POS_API_KEY=" $E | cut -d= -f2- | tr -d "\""); U=$(grep -m1 "^POS_API_URL=" $E | cut -d= -f2- | tr -d "\""); curl -s -o /dev/null -w "%{http_code}\n" -H "x-api-key: $K" "$U/api/external/payment-methods?storeId=L5MExycvUOfQ96Y10FqF"'
```
`200` = working. `401` = POS has not picked up the map (step 2.4). `403` = Lipa is not in the map.

## After this
Per store, before linking it on production: T-375 **S0** (the 90-day census of live POS data; the script
`scripts/pos-v1-feed-census.ts` is specced, not yet built), then link stores one by one with Ian (DEF-586 closes
store by store).
