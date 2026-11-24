TODO app - what to do

1. Upload every file in this folder to your website (replace the old ones):
   index.html, style.css, app.js, favicon.svg, favicon-32.png, apple-touch-icon.png
   Then open the site and press Ctrl+F5 once so the new files load.
   (supabase.sql did not change in this update. If you already ran it, you do not need to run it again.)

   NEW: the whole website now fits phones (iPhone and Android) as well as tablets and laptops.
   It was checked at 320, 390, 412 and 768 pixels wide: no sideways scrolling, the top bar fits,
   text boxes do not make iPhone zoom in, and the notch / home bar area is respected.
   To use it like an app: in Safari tap Share > Add to Home Screen; in Chrome on Android tap
   the menu > Add to Home screen.

   "Forgot password?" on the login card. See step 4 below for the
   one-time Supabase check that makes the reset email work.

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

4. Forgot password: how it works and what to check
   How it works for your visitors:
   - On the login card they click "Forgot password?", type their email, and press "Send reset link".
   - They get an email from Supabase. The link is valid for 1 hour and works once.
   - The link opens your website on a "Choose a new password" card (same password rules as
     Create account). After saving, they are logged in and their other devices are logged out.
   - The "Send reset link" button waits 60 seconds before it can be pressed again.
   - The message is the same whether or not the email has an account, so strangers cannot
     use the form to find out who is registered.

   One-time checks in Supabase (about 2 minutes):
   A) Authentication > URL Configuration: the Site URL and Redirect URLs from step 2A must be
      your real website address. If it is missing, the email link will send people to the wrong
      page or show an error. (Add http://localhost too if you test on XAMPP.)
   B) Authentication > Sign In / Providers > Email: must be ON.
   C) Authentication > Email Templates > "Reset Password": the default works as is. You can
      change the wording, but keep {{ .ConfirmationURL }} in it.
   D) EMAIL LIMIT: Supabase's built-in email sender is only for testing and allows just a few
      emails per hour for the whole project. For a real site, add your own email service:
      Authentication > Emails > SMTP Settings (Brevo, Resend, Gmail SMTP, etc. have free plans).
      If people see "email rate limit exceeded", this is the reason.

   If something goes wrong:
   - "That reset link has expired or was already used": ask for a new link.
   - No email arrives: check spam, check that the email really has an account, and see D above.
   - The link opens the login page instead of the new-password card: the Redirect URL in A is
     missing or does not match your website address exactly.
   - Reset does not work when index.html is opened from your computer. Use your website
     address (http or https).
   - People who only used Google or Facebook can also use "Forgot password?"; it simply lets
     them add a password for email login too.

Your Supabase URL and key are already in app.js.
Contact form messages: Supabase > Table Editor > contact_messages.
