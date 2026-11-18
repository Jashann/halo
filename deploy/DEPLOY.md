# Deploying Halo to Cloud Run

One container (built web app + agent server, same port, WebSocket included) on Cloud Run in the shared project.
The image is built by Cloud Build, so no local Docker is needed. Run everything from the `jarvis-vr` root.

Why not `gcloud run deploy --source .`: that path needs a `Dockerfile` at the source root, and ours lives in
`server/Dockerfile` (build context = repo root). `gcloud builds submit --config deploy/cloudbuild.yaml` is the same
Cloud Build flow with the Dockerfile path spelled out, followed by `gcloud run deploy --image`.

Checked on 2026-11-16 (read only): Cloud Run, Cloud Build, Artifact Registry, Secret Manager and Billing Budgets
APIs are already enabled; the billing account already has the account-wide budget `free-credit-guard`
(425 CAD, alerts at 50/75/90/100%). Never change or delete that one. Step 6 adds a small Halo-only budget.

## 0. Variables

```bash
export PROJECT=YOUR_PROJECT_ID
export REGION=us-central1
export BILLING=YOUR_BILLING_ACCOUNT
export IMAGE=$REGION-docker.pkg.dev/$PROJECT/halo/halo:latest
export SA=halo-run@$PROJECT.iam.gserviceaccount.com
gcloud config set project $PROJECT
```

## 1. Secret: the Meta API key (one time)

Reads the key straight from the file, so it is never printed or typed. The server trims the trailing newline.

```bash
gcloud secrets create halo-meta-api-key \
  --replication-policy=automatic \
  --labels=app=halo,owner=you \
  --data-file="$HOME/.meta_api_key"
```
To rotate later: `gcloud secrets versions add halo-meta-api-key --data-file="$HOME/.meta_api_key"`.

## 2. Runtime service account with access to that one secret (one time)

```bash
gcloud iam service-accounts create halo-run --display-name="Halo Cloud Run"
gcloud secrets add-iam-policy-binding halo-meta-api-key \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
```

## 3. Artifact Registry repository (one time)

```bash
gcloud artifacts repositories create halo \
  --repository-format=docker --location=$REGION \
  --labels=app=halo,owner=you
```

## 4. Build the image with Cloud Build

```bash
gcloud builds submit --config deploy/cloudbuild.yaml --ignore-file=deploy/.gcloudignore --region=$REGION .
```
The build runs `npm ci && npm run build` in `web/` (Node 22), then installs the server (Node 20 slim + ffmpeg).
If the push is refused with a permission error, grant the build service account
(`gcloud builds get-default-service-account`) `roles/artifactregistry.writer` and `roles/logging.logWriter`.

## 5. Deploy

```bash
gcloud run deploy halo \
  --image=$IMAGE \
  --region=$REGION \
  --service-account=$SA \
  --set-secrets=META_API_KEY=halo-meta-api-key:latest \
  --allow-unauthenticated \
  --port=8080 \
  --min-instances=0 --max-instances=2 \
  --memory=1Gi --cpu=1 \
  --concurrency=40 \
  --timeout=3600 \
  --session-affinity \
  --labels=app=halo,owner=you
```
- `--timeout=3600` is the longest a single WebSocket may stay open; the page should reconnect after that.
- `--session-affinity` keeps a browser on the same instance, so its conversation and memory stay put.
- Memory files live in `/data` inside the container: they survive while an instance is warm and reset when it
  scales to zero. That is fine for the demo; a bucket mount would make it permanent.
- The cost guard is on by default (per connection: 20 model calls/min, 300 per session, 8 codegen calls per
  session, 12 voice clips/min; per instance: 300 model calls/min, 150 codegen calls/hour, 40 sessions, 4 per IP).
  Override with `--set-env-vars=AIDE_MODEL_PER_MIN=...` etc. (names in `server/src/config.js`).

## 6. Halo-only budget alert (one time)

```bash
gcloud billing budgets create \
  --billing-account=$BILLING \
  --display-name=halo-guard \
  --budget-amount=30CAD \
  --filter-projects=projects/$PROJECT \
  --filter-labels=app=halo \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0
```
Alerts go to the billing admins by email. Budgets do not stop spending; `--max-instances=2`, `--min-instances=0`
and the cost guard are what cap it. Meta API usage is billed by Meta, not GCP, and is capped by the cost guard.

## 7. Check

```bash
URL=$(gcloud run services describe halo --region=$REGION --format='value(status.url)')
curl -s $URL/health        # {"ok":true,...,"keyConfigured":true,"web":true}
echo $URL                  # open on the Quest browser; the WebSocket uses the same host (wss://)
```
Logs: `gcloud run services logs read halo --region=$REGION --limit=50` (they never contain the key or images).

## Update after code changes

Repeat steps 4 and 5 (the secret, account, repository and budget stay).

## Tear down (after the contest)

```bash
gcloud run services delete halo --region=$REGION
gcloud artifacts repositories delete halo --location=$REGION
gcloud secrets delete halo-meta-api-key
gcloud iam service-accounts delete $SA
BUDGET=$(gcloud billing budgets list --billing-account=$BILLING --filter="displayName=halo-guard" --format='value(name)')
gcloud billing budgets delete $BUDGET
```

## Expected cost

With min instances 0, Cloud Run costs nothing while idle. An active demo (1 vCPU, 1 GiB, one WebSocket open)
costs about 0.13 CAD per hour of connected time. Cloud Build on E2_HIGHCPU_8 is about 0.02 CAD per build minute
(a build takes a few minutes), and Artifact Registry storage is a few cents a month for one image.
