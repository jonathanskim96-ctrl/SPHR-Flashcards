# Setup guide (for Jonathan)

Do these steps in order, one at a time. Each step says what it changes and what happens if
you skip it. When a step says "Claude will paste", ask the build session in chat for that
text; it pastes it as a code block with a copy button. Never paste a link into an editor.

Website menus get renamed from time to time. If a button isn't exactly where this says,
look for the closest match and tell Claude what you see.

Keep a **password manager** (or a private note) open: you'll save a few secret values.
Never put them in GitHub files or in a message to anyone else.

Some parts need the app to be built first. The build session tells you when to do each part.

---

## Part A: GitHub

### A1. Protect `main` (ruleset)
Changes: nobody (including an AI session) can force-push to `main` or delete it. Normal
pushes still work. If you skip it, a single bad command could erase history.
1. Go to https://github.com/jonathanskim96-ctrl/SPHR-Flashcards
2. Click **Settings** (the gear tab at the top right of the repo).
3. In the left menu, click **Rules** → **Rulesets**.
4. Click **New ruleset** → **New branch ruleset**.
5. **Ruleset name**: `Protect main`. **Enforcement status**: **Active**.
6. Under **Target branches**, click **Add target** → **Include default branch**.
7. Under **Rules**, make sure **Restrict deletions** and **Block force pushes** are ticked.
   Untick everything else.
8. Leave **Bypass list** empty. Click **Create**.

### A2. Turn on GitHub Pages
Changes: lets the deploy workflow publish the app at
https://jonathanskim96-ctrl.github.io/SPHR-Flashcards/
1. Repo **Settings** → left menu **Pages**.
2. Under **Build and deployment** → **Source**, choose **GitHub Actions**. (Nothing else
   to save.)

### A3. Public values for the app (repository variables)
Do this after Part B, when you have the values. Changes: the app knows which Supabase
project to talk to. These values are public by design.
1. Repo **Settings** → left menu **Secrets and variables** → **Actions**.
2. Click the **Variables** tab → **New repository variable**. Add these three, one at a time:
   - Name `VITE_SUPABASE_URL`, value: your Project URL (B2), like `https://abcd1234.supabase.co`
   - Name `VITE_SUPABASE_PUBLISHABLE_KEY`, value: the publishable key (B2), starts `sb_publishable_`
   - Name `VITE_VAPID_PUBLIC_KEY`, value: the VAPID public key Claude gives you (B7)

### A4. The one GitHub secret
Changes: lets the "Import questions" and "Keep Supabase awake" workflows write to the
database. It is stored encrypted and is never visible in logs.
1. Same page (**Secrets and variables** → **Actions**), click the **Secrets** tab →
   **New repository secret**.
2. Name `SUPABASE_SECRET_KEY`, value: the secret key from B2 (starts `sb_secret_`).
   Click **Add secret**.

---

## Part B: Supabase

### B1. Create the project
1. Go to https://supabase.com and click **Start your project**. Sign in with GitHub.
2. If asked to create an organization: name it `Jonathan`, plan **Free**.
3. Click **New project**. **Name**: `sphr-flashcards`. **Database password**: click
   **Generate a password**, then **copy it into your password manager now**.
   **Region**: the one closest to Michelle (e.g. **West US (North California)**).
   Plan: **Free**.
4. Click **Create new project** and wait 1–2 minutes until the dashboard loads.

### B2. Copy the project URL and keys
1. Left sidebar, bottom: **Project Settings** (gear icon).
2. **Data API** (or **API**) → copy the **Project URL** into your password manager.
3. **API Keys** → copy the **Publishable key** (`sb_publishable_…`).
4. On the same page, under **Secret keys**, click **Create new secret key** if there
   isn't one, name it `github-actions`, then reveal and copy it (`sb_secret_…`) into your
   password manager. **Never paste this one into a chat, a file, or a variable.** It
   only goes into the GitHub *secret* in A4.
5. Now do A3 (first two values) and A4.

### B3. Run the database setup SQL
Changes: creates the tables, the security rules, the safety log, and the functions. On a
brand-new project nothing can be lost. For any *later* migration, first do an export on
Michelle's phone (Settings → Export progress).
1. Left sidebar: **SQL Editor**.
2. Click **+** / **New query**.
3. Claude pastes migration `0001` in chat. Click its copy button, click in the editor, and
   paste (Cmd+V / Ctrl+V).
4. Click **Run** (bottom right). If a box warns about **"destructive operations"**, that's a
   false alarm: the file *mentions* "delete" because it contains rules that *block*
   deletes. Click **Run this query** to confirm.
5. You should see **Success. No rows returned**. If you see an error, copy the red text and
   paste it to Claude. **Do not run the next file.**
6. Repeat steps 2–5 for `0002`, then `0003` (one at a time, in order).

### B4. Turn off public sign-ups
Changes: nobody can create an account in your app. If you skip it, a stranger could sign up.
1. Left sidebar: **Authentication** → **Sign In / Providers** (may be under
   **Configuration**).
2. Turn **off** **Allow new users to sign up**. Click **Save**.
3. Under **Auth Providers**, open **Email**: leave it **enabled**, set **Minimum password
   length** to `12` if the option is there, and click **Save**. Leave every other provider
   (Google, Apple, phone, etc.) **disabled**.

### B5. Set the app address
1. **Authentication** → **URL Configuration**.
2. **Site URL**: `https://jonathanskim96-ctrl.github.io/SPHR-Flashcards/`. Click **Save**.

### B6. Create Michelle's account
1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. **Email**: Michelle's email. **Password**: make a strong one (12+ characters) and save
   it in your password manager, then tell her privately.
3. Tick **Auto Confirm User**. Click **Create user**.

### B7. Reminder secrets (Edge Function secrets)
Changes: stores the keys the server uses to send notifications. They never go into GitHub.
1. Claude gives you, **in chat**, a VAPID public key and a VAPID private key (made once).
   Put both in your password manager.
2. In your password manager, generate a random 40-character password with letters and
   digits only. This is your **cron secret**.
3. Supabase left sidebar: **Edge Functions** → **Secrets** (or Project Settings → **Edge
   Functions**). Add each with **Add new secret**:
   - `VAPID_PUBLIC_KEY`: the public key
   - `VAPID_PRIVATE_KEY`: the private key
   - `VAPID_SUBJECT`: `mailto:` followed by your email, e.g. `mailto:you@example.com`
   - `CRON_SECRET`: the cron secret
   Click **Save** after each.
4. Do A3's third value (`VITE_VAPID_PUBLIC_KEY`) now.

### B8. Deploy the reminder function
1. Left sidebar: **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `send-reminders`.
3. Delete the sample code in the editor. Claude pastes the function code in chat; paste it in.
4. Click **Deploy function**. Wait for "Deployed".
5. Open the function's **Details** / **Settings** and turn **off** **Enforce JWT
   verification** (the function checks the cron secret itself). Click **Save**.

### B9. Schedule the reminder job
Changes: every 15 minutes the database calls `send-reminders`, which sends her reminder
when it's her chosen time. If you skip it, no reminders are ever sent.
1. Left sidebar: **Database** → **Extensions**. Search `pg_cron` and switch it **on**. Search
   `pg_net` and switch it **on**.
2. **SQL Editor** → **New query**. Paste this, then replace the two `PASTE_…` parts
   (keep the single quotes):
   ```sql
   select vault.create_secret('https://PASTE_PROJECT_REF.supabase.co', 'project_url');
   select vault.create_secret('PASTE_CRON_SECRET', 'cron_secret');
   ```
   The project ref is the part of your Project URL between `https://` and `.supabase.co`.
   Click **Run**. You should see two rows with ids.
3. **New query** again. Paste this exactly (no changes needed) and click **Run**:
   ```sql
   select cron.schedule(
     'send-reminders',
     '*/15 * * * *',
     $$
     select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
              || '/functions/v1/send-reminders',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 10000
     );
     $$
   );
   ```
   You should see one number (the job id).
4. Check it: left sidebar **Integrations** → **Cron** → **Jobs**: `send-reminders` is listed
   and **Active**. After 15 minutes the **History** tab shows a run marked succeeded.

---

## Part C: First deploy

1. The build session asks you for OK to merge into `main`. Reply OK only when it says all
   checks passed.
2. Repo → **Actions** tab → click the newest **Deploy** run → wait for a green ✓ (not
   "cancelled" or "skipped").
3. Open https://jonathanskim96-ctrl.github.io/SPHR-Flashcards/ in your browser and sign
   in with Michelle's account to check it works.

## Part D: Keep-alive check

1. Repo → **Actions** → left list **Keep Supabase awake** → **Run workflow** (right side) →
   green **Run workflow** button.
2. Refresh after a minute: the run should have a green ✓. From now on it runs daily by itself.
3. If GitHub ever emails you that scheduled workflows were disabled for inactivity, open
   this same page and click **Enable workflow**.

## Part E: Load the questions into Supabase (first import)

1. Repo → **Actions** → **Import questions** → **Run workflow**. Leave **apply**
   **unticked** → **Run workflow**.
2. Open the run when it finishes → scroll to the **Summary**. It should say
   **PREVIEW ONLY: nothing was written** and **400 new**.
3. If that looks right: **Run workflow** again, tick **apply**, **Run workflow**. The
   summary should say **APPLIED: 400 new, 0 changed**. (Ticking apply is your approval for
   that one database write.)

## Part F: Adding or fixing questions later (3 steps)

1. On GitHub, open `content/questions.json` → pencil icon (**Edit**) → paste your updated
   file over the old one. **Raise `bankVersion`** (e.g. `2026-11-02.1`). For any edited
   question, raise its `revision` by 1. To remove a question, set `"status": "retired"`;
   never delete it. Click **Commit changes…** → commit directly to `main`.
   - CI runs the validator. If it fails, the Actions tab shows a red ✗, nothing is deployed
     or imported, and Michelle's app is untouched. Open the run to read the errors and fix
     the file.
   - If it passes, the app redeploys and her phone gets the new questions next time she
     opens the app.
2. **Actions** → **Import questions** → **Run workflow** (apply unticked) → read the
   preview (e.g. "12 new, 3 changed, 1 newly retired, 0 errors").
3. If it matches what you meant to change: run it again with **apply** ticked.

## Part G: Confirm the facts the plan relies on

The planning session couldn't open these sites directly, so check them once:
1. Supabase dashboard → your project → **Project Settings** → **General**: read any note
   about pausing. Free projects pause after about 7 days of low activity. Tell Claude if it
   says something different.
2. **Organization** → **Usage** (or Billing → Usage): it shows **Edge Function
   Invocations** with a free quota (expected 500,000 a month). We'll use about 2,900.
3. The plan must stay **Free**. If anything ever asks you to upgrade to keep working,
   stop and tell Claude.
