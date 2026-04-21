# AWS Deployment Guide — Sturtz Maschinenbau Support Chatbot

This guide covers everything needed to deploy the full stack on AWS using the provided `cloudformation.yml`.

---

## Architecture Overview

```
Internet
    │  port 80
    ▼
EC2 (t3.large, AL2023)
    ├── chat-web  (nginx, :80)   — serves React SPA, proxies /api/ internally
    ├── api-server (Node 24, :8080)  — Express, auth, orchestration
    ├── rag-service (FastAPI, :8000) — ingestion, vectorless RAG
    └── pageindex   (FastAPI, internal) — tree-of-contents builder
         │
         ▼
    AWS Bedrock (Claude via IAM instance role)
         │
    RDS PostgreSQL 16 (private subnet, pgvector enabled)
         │
    S3 Bucket (document uploads, presigned URLs)
```

All four app services run as Docker containers on a single EC2 instance via `docker-compose.aws.yml`. PostgreSQL runs on RDS (not in Docker). No static AWS credentials — the EC2 IAM instance role handles all AWS auth (S3 + Bedrock).

---

## Prerequisites

### 1. AWS account requirements

- [ ] IAM user or role with permissions to create: VPC, EC2, RDS, S3, IAM roles, CloudFormation
- [ ] **Bedrock model access enabled** in your target region for:
  - `anthropic.claude-sonnet-4-5` (chat)
  - `anthropic.claude-sonnet-4-6` (pageindex)
  - Go to **AWS Console → Bedrock → Model access** and request access for both models
- [ ] An EC2 Key Pair created in the target region (used for SSH access)
- [ ] AWS CLI installed and configured (`aws configure`)

### 2. Repository must be publicly accessible

The EC2 UserData clones the repository during first boot using:
```bash
git clone <GitRepoUrl> /opt/sturtz/app
```

**Option A — Public GitHub repo (simplest):**
Make the repository public before deploying.

**Option B — Private repo:**
Add a deploy key or personal access token to the UserData. Edit `cloudformation.yml` around line 406:
```bash
# Replace:
git clone ${GitRepoUrl} /opt/sturtz/app

# With (using a token stored in SSM):
TOKEN=$(aws ssm get-parameter --name /sturtz/github-token --with-decryption --query Parameter.Value --output text)
git clone https://oauth2:$TOKEN@github.com/your-org/main-app.git /opt/sturtz/app
```
Then store the token: `aws ssm put-parameter --name /sturtz/github-token --value ghp_xxx --type SecureString`
And add `ssm:GetParameter` to the EC2 IAM role in the CF template.

### 3. S3 bucket name

S3 bucket names are globally unique. Choose something like `sturtz-docs-yourcompanyname`. You cannot reuse a name taken by another AWS account.

---

## Required Code Changes Before Deploying

These changes need to be made to the codebase and committed before running CloudFormation.

### Change 1 — Add a `Dockerfile` to `pageindex/`

The `pageindex/` directory already has a `Dockerfile` — verify it exposes port 8000 and has a `/health` endpoint. The docker-compose.aws.yml healthcheck calls `http://localhost:8000/health`. If the endpoint doesn't exist, add it to `pageindex/server.py`:

```python
@app.get("/health")
def health():
    return {"status": "ok"}
```

### Change 2 — Ensure `lib/db` has a `push` script

The UserData runs `pnpm --filter @workspace/db run push` to apply the Drizzle schema to RDS. Verify `lib/db/package.json` has this script:

```json
{
  "scripts": {
    "push": "drizzle-kit push"
  }
}
```

And that `lib/db/drizzle.config.ts` (or equivalent) reads `DATABASE_URL` from the environment:

```ts
export default {
  schema: './src/schema/*',
  out: './drizzle',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
};
```

### Change 3 — Ensure `api-server` has a `seed-admin` script

The UserData runs `pnpm --filter @workspace/api-server run seed-admin`. Verify `artifacts/api-server/package.json` has this script and that it reads `DATABASE_URL` from the environment (not hardcoded).

### Change 4 — Verify `.npmrc` doesn't block production installs

The UserData runs `pnpm install --frozen-lockfile` on the EC2 host. If `.npmrc` has any settings that require auth tokens (e.g., private registries), those need to be available on the EC2 host or removed from the prod install path.

### Change 5 — Pin Docker Compose version (optional but recommended)

The CF template downloads Docker Compose v2.27.1. If you need a different version, update line 391 of `cloudformation.yml`:
```yaml
curl -fsSL "https://github.com/docker/compose/releases/download/v2.27.1/docker-compose-linux-x86_64"
```

---

## Deployment Steps

### Step 1 — Validate the template

```bash
aws cloudformation validate-template --template-body file://cloudformation.yml
```

### Step 2 — Deploy the stack

```bash
aws cloudformation deploy \
  --template-file cloudformation.yml \
  --stack-name sturtz-prod \
  --capabilities CAPABILITY_NAMED_IAM \
  --region eu-central-1 \
  --parameter-overrides \
    KeyName=your-keypair-name \
    GitRepoUrl=https://github.com/your-org/main-app.git \
    GitBranch=main \
    PostgresPassword=YourStr0ngPassw0rd \
    JwtSecret=your_minimum_32_character_jwt_secret_here \
    RagInternalSecret=your_16char_secret \
    S3BucketName=sturtz-docs-yourcompanyname \
    SeedAdminEmail=admin@yourcompany.com \
    SeedAdminPassword=YourAdminPassword \
    RdsInstanceClass=db.t3.medium \
    InstanceType=t3.large
```

**Parameters reference:**

| Parameter | Required | Notes |
|---|---|---|
| `KeyName` | Yes | Name of an existing EC2 Key Pair in the target region |
| `GitRepoUrl` | Yes | HTTPS URL, e.g. `https://github.com/org/main-app.git` |
| `GitBranch` | No | Default: `main` |
| `PostgresPassword` | Yes | Min 8 chars. Used for RDS master password |
| `JwtSecret` | Yes | Min 32 chars. Used to sign JWTs |
| `RagInternalSecret` | Yes | Min 16 chars. Shared secret between api-server and rag-service |
| `S3BucketName` | Yes | Globally unique bucket name |
| `SeedAdminEmail` | No | Default: `admin@sturtz.com` |
| `SeedAdminPassword` | No | Default: `changeme123` — **change this** |
| `RdsInstanceClass` | No | Default: `db.t3.medium`. Use `db.t3.micro` to save cost |
| `InstanceType` | No | Default: `t3.large`. Use `t3.medium` for low traffic |
| `BedrockChatModelId` | No | Default: `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `PageindexModel` | No | Default: `bedrock/eu.anthropic.claude-sonnet-4-6` |

### Step 3 — Monitor the deployment

The stack takes approximately **15–25 minutes** (RDS provisioning is the longest step). Watch progress:

```bash
# Watch stack events in real time
aws cloudformation describe-stack-events \
  --stack-name sturtz-prod \
  --query 'StackEvents[*].[Timestamp,ResourceStatus,ResourceType,LogicalResourceId]' \
  --output table

# Or watch in the AWS Console:
# CloudFormation → Stacks → sturtz-prod → Events tab
```

The EC2 instance signals CloudFormation when setup completes. If the signal doesn't arrive within 30 minutes, the stack rolls back.

### Step 4 — Get the app URL

```bash
aws cloudformation describe-stacks \
  --stack-name sturtz-prod \
  --query 'Stacks[0].Outputs' \
  --output table
```

The `AppURL` output gives you `http://<elastic-ip>`. Open it in a browser — you should see the login page.

Log in with the `SeedAdminEmail` and `SeedAdminPassword` you specified.

---

## Verifying the Deployment

### Check services are running (SSH into EC2)

```bash
# From the Outputs: SSHCommand
ssh -i your-key.pem ec2-user@<elastic-ip>

# Check container status
sudo docker compose -f /opt/sturtz/app/docker-compose.aws.yml ps

# Tail logs for all services
sudo docker compose -f /opt/sturtz/app/docker-compose.aws.yml logs -f

# Tail UserData setup log (if something went wrong during boot)
sudo cat /var/log/sturtz-userdata.log
```

Expected container states:
```
NAME           STATUS
chat-web       Up (healthy or running)
api-server     Up
rag-service    Up
pageindex      Up (healthy)
```

### Health check endpoints

```bash
curl http://<elastic-ip>/api/health     # api-server (via nginx proxy)
```

### Check the database

```bash
# From inside the EC2 instance
PGPASSWORD=yourpassword psql \
  -h <rds-endpoint> \
  -U postgres \
  -d sturtz \
  -c "\dt"   # should list: users, documents, document_chunks, conversations, messages, sessions
```

---

## Re-deploying / Updating the App

After pushing code changes to your repo:

```bash
# SSH into the EC2 instance
ssh -i your-key.pem ec2-user@<elastic-ip>

cd /opt/sturtz/app

# Pull latest code
sudo git pull origin main

# Rebuild only changed services (Docker layer cache helps)
sudo docker compose -f docker-compose.aws.yml build

# Restart with zero-downtime rolling update
sudo docker compose -f docker-compose.aws.yml up -d
```

If you changed the DB schema:
```bash
DATABASE_URL="postgresql://postgres:PASSWORD@RDS_ENDPOINT:5432/sturtz" \
  pnpm --filter @workspace/db run push
```

---

## Updating CloudFormation Stack Parameters

To change a parameter (e.g., upgrade the EC2 instance type):

```bash
aws cloudformation update-stack \
  --stack-name sturtz-prod \
  --use-previous-template \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=InstanceType,ParameterValue=t3.xlarge \
    ParameterKey=KeyName,UsePreviousValue=true \
    ParameterKey=GitRepoUrl,UsePreviousValue=true \
    ParameterKey=PostgresPassword,UsePreviousValue=true \
    ParameterKey=JwtSecret,UsePreviousValue=true \
    ParameterKey=RagInternalSecret,UsePreviousValue=true \
    ParameterKey=S3BucketName,UsePreviousValue=true
```

> **Note:** Changing `InstanceType` replaces the EC2 instance. The Elastic IP re-associates automatically, but app downtime will occur during instance replacement (~2–3 min). Docker images must be rebuilt on the new instance via UserData.

---

## Tearing Down

```bash
# This deletes everything EXCEPT the RDS (which creates a final snapshot)
aws cloudformation delete-stack --stack-name sturtz-prod

# If the S3 bucket has objects, CloudFormation cannot delete it automatically.
# Empty it first:
aws s3 rm s3://your-bucket-name --recursive
```

---

## Cost Estimate (eu-central-1, approximate)

| Resource | Type | Monthly cost |
|---|---|---|
| EC2 | t3.large | ~$60 |
| RDS | db.t3.medium | ~$60 |
| S3 | Storage + requests | ~$1–5 |
| Elastic IP | (free while attached) | $0 |
| Data transfer | Varies | ~$5–20 |
| **Total** | | **~$125–145/month** |

To reduce cost in non-production environments, use `t3.medium` ($30) + `db.t3.micro` ($15) ≈ **$50/month**.

---

## Known Limitations and Future Improvements

| Limitation | Impact | Future fix |
|---|---|---|
| Single EC2 instance | No high availability; instance failure = downtime | Add ASG + ALB |
| No HTTPS | Traffic is unencrypted | Add ACM cert + ALB with HTTPS listener |
| EC2 stores Docker images locally | Rebuilding on new instances is slow | Push images to ECR, pull on deploy |
| Postgres in RDS, single AZ | DB failure = downtime | Enable MultiAZ |
| Secrets in CF parameters | Visible in CloudFormation console | Move to AWS Secrets Manager |
| No automated backups of S3 | Object deletion is permanent | Enable S3 versioning (already enabled) + cross-region replication |
| All services on one EC2 | Resource contention under heavy load | Split pageindex/rag-service to separate EC2 or use ECS |
