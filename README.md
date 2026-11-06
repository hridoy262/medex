# Medex Medicine Price Search

ওষুধের নাম, জেনেরিক বা কোম্পানি দিয়ে সার্চ করুন। দামের জন্য অ্যাপটি MedEx-এর
সর্বশেষ অনলাইন তথ্য ব্যবহার করে; অনলাইনে দাম পাওয়া না গেলে পুরোনো ডাটাবেজের
দাম দেখায় না।

## চালানো

1. Node.js ইনস্টল করুন।
2. প্রোজেক্ট রুটে `.env` ফাইল তৈরি করে MongoDB সংযোগ দিন:

   ```env
   MONGODB_URI=your_mongodb_connection_string
   PORT=5000
   ```

3. Dependencies ইনস্টল ও সার্ভার চালান:

   ```sh
   npm install
   npm start
   ```

4. ব্রাউজারে `http://localhost:5000` খুলুন।

Credentials কখনো Git-এ যোগ করবেন না। `.env` এবং `atlas-credentials.env`
ইতিমধ্যে `.gitignore`-এ বাদ দেওয়া আছে।
