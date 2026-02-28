HIT-Portal (Supabase Auth build)
Open index.html.


========================================
COMMUNITY BACKEND (Resources + Q&A)
========================================
1) In Supabase -> SQL Editor, run: SUPABASE_COMMUNITY_TABLES.sql
2) (Optional) Run your Copilot tables SQL if you haven't: student_activity, student_risk, study_plan
3) In the app:
   - Students use Resource Hub and Q&A normally.
   - If those tables exist, the app automatically uses the database (community mode).
   - If not, it falls back to local app_state for offline demo.

Notes:
- Resources are inserted as status='pending'. Admin can approve by setting status='approved' in Table Editor.
- Q&A questions are visible by department. Admin can hide by setting status='hidden'.


========================================
COURSE ASSIGNMENT SYSTEM
========================================
1) Run SUPABASE_COURSE_ASSIGNMENT.sql in Supabase SQL Editor.
2) Admin: open Manage Courses (admin-courses.html) to assign courses per Department + Part.
3) Student: My Courses shows only courses for their Department + Part and allows enroll. Manual add limit: 3.
4) Profile: change Part and Save.


========================================
REQUESTED FEATURES
========================================
Run SUPABASE_REQUESTED_FEATURES.sql in Supabase SQL Editor.
- Part changes are limited to 2/day (extra attempts logged).
- Resource Hub supports View/Download/Save, and Saved Docs list.
- Q&A owners can edit/delete; top questions are ordered by interactions.


========================================
QA REACTIONS + COMMENTS (DB)
========================================
Run SUPABASE_QA_REACTIONS_COMMENTS.sql in Supabase SQL Editor.
This enables DB-backed likes/dislikes/comments and improves Top Interactions ranking.


========================================
BACKGROUND IMAGES (Supabase Storage)
========================================
This build uploads panel background images to Supabase Storage (recommended).

1) Create a Storage bucket named: backgrounds
   - Make it PUBLIC if you want backgrounds to load for everyone without signed URLs.

2) Add Storage policies:
   - To allow authenticated uploads:
     - Allow INSERT/UPDATE on storage.objects where bucket_id = 'backgrounds' for authenticated users.
   - To allow public read (if bucket is not public):
     - Allow SELECT on storage.objects where bucket_id = 'backgrounds' for anon/auth.

If Storage upload fails (bucket missing or policies blocked), the app will fall back to saving the image locally on the current device.

