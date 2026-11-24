TODO app - what to do

1. Upload every file in this folder to your website (replace the old ones):
   index.html, style.css, app.js, favicon.svg, favicon-32.png, apple-touch-icon.png
   Then open the site and press Ctrl+F5 once so the new files load.
   (supabase.sql did not change in this update. If you already ran it, you do not need to run it again.)

2. Google and Facebook buttons: one-time setup. The buttons are already on the login card,
   but they only work after you switch the two providers on in Supabase.
   They only work on your real website address (http or https), not when you open index.html
   straight from your computer.

   YOUR CALLBACK URL (you will paste it into Google and Facebook below):
   https://cfadwunwdrkjhighrxwh.supabase.co/auth/v1/callback

   A) Supabase > Authentication > URL Configuration
      - Site URL: your website address, for example https://yourname.github.io/todo/
      - Redirect URLs: add the same address (add http://localhost too if you test on XAMPP).

   B) Google
      1. Go to console.cloud.google.com and create a project (or pick one).
      2. Set up the OAuth consent screen (app name, your email). While it says "Testing",
         only people you add as Test users can sign in. Publish it so everyone can.
      3. Credentials > Create credentials > OAuth client ID > Web application.
         - Authorized JavaScript origins: your website address (just the domain, like https://yourname.github.io)
         - Authorized redirect URIs: the CALLBACK URL above
      4. Copy the Client ID and Client secret.
      5. Supabase > Authentication > Sign In / Providers (older dashboards: Providers) > Google >
         turn it ON, paste the Client ID and secret, Save.

   C) Facebook
      1. Go to developers.facebook.com > My Apps > Create App. Choose the use case
         "Authenticate and request data from users with Facebook Login".
      2. In the app, make sure the permissions public_profile and email are enabled.
      3. Facebook Login > Settings > Valid OAuth Redirect URIs: paste the CALLBACK URL above, Save.
      4. App settings > Basic: copy the App ID and the App Secret.
      5. Supabase > Authentication > Sign In / Providers > Facebook >
         turn it ON, paste the App ID and App Secret, Save.
      6. Facebook apps start in Development mode, where only people with a role on the app
         (you, testers) can sign in. Switch the app to Live when you are ready for everyone.

3. How it behaves
   - Signing in with Google or Facebook creates the account automatically on the first time.
     Their name and picture are used until you set your own in Profile.
   - If someone already has an email account with the same email address, Supabase normally
     connects both ways of signing in to the same account.
   - People who only use Google or Facebook have no password here, so Settings shows a note
     instead of the Change password form.
   - If a button shows a Supabase error page instead of Google or Facebook, that provider is
     not switched on yet (step 2B or 2C), or the Redirect URL in step 2A is missing.

Your Supabase URL and key are already in app.js.
Contact form messages: Supabase > Table Editor > contact_messages.
