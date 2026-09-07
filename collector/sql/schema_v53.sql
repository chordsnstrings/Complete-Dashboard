-- ── 93 people who were on the roster more than once, folded onto one key each ──
-- ---------------------------------------------------------------------------
-- person_key is what every surface in this product groups people by, and it
-- was the folded NAME and nothing else: lowercase, collapse runs of
-- whitespace, collapse an adjacent repeated word (sql/schema_v20.sql for trip,
-- driver_platform_state and vehicle_driver_day; v42 for the earnings
-- components; v51 for the statements and payouts).
--
-- That fold cannot see the duplicates this fleet actually has, and MUST NOT be
-- taught to. Some are the same names in the opposite order ("Aliyan khalil" on
-- Uber against "Khalil Aliyan" on Yango) and one is a transliterated vowel
-- ("Shehzad Ahmad" against "Shehzad Ahmed"). Most are the shape the roster
-- produces every day: Bolt and the hotel channel file the full legal name and
-- Uber drops the middle one — "Zubair Khan Shaukat Ali" against "Zubair Khan
-- Ali", "Zia Ali Said Muhammad" against "Zia Ali Muhammad". Every rule loose
-- enough to catch those is loose enough to merge two men: this product's own
-- test/roster_twin.test.mjs pins "Muhammad Khalid Gul" and "Muhammad Khalid"
-- apart as two humans on two cars, and a subsequence rule would join them.
--
-- So the merge is a LIST, and each entry says what decided it. Two kinds sit
-- in it now. Some were checked one pair at a time against production — shared
-- plates, interleaved custody days, the gap between one record handing a car
-- to the other. The rest were found by src/identity_link.js on a phone number
-- both channels filed against the same person, which over the 289 roster rows
-- appears on no more than two records and never twice within one channel.
-- Twenty-six people were found by both, independently.
--
-- What is NOT here is any pair with a contradiction: a day on which both
-- records took a trip at the same time. Five carry one, they stay in PENDING,
-- and a simultaneous trip outranks a shared phone every time.
--
-- So the merge is a LIST of verified ids, not a rule. api/identity_map.js holds
-- it together with the measurement that decided each one. THIS FILE IS
-- GENERATED from that register by bin/gen-schema-v53.mjs, and
-- test/identity_merge.test.mjs re-runs the generator and fails if the two have
-- drifted apart.
--
-- The register, as it stands:
--
-- 7fc8da91fc4a44c185e8d6d918db3e6b (yango "Khalil Aliyan")
--   -> 5f16534e-68be-451b-b057-3e3d948e868b (uber "Aliyan khalil") = 'aliyan khalil'
--   verified 2026-09-03 on plate L36397
-- ab2aec60-56ff-48e2-85c0-3591f6f29aa3 (bolt "Arthur Moses")
--   -> 9d396a20-454b-4a7e-91ae-9de8f9aa8942 (uber "Moses Arthur") = 'moses arthur'
--   verified 2026-09-03 on plate L10595
-- 67483c64055e070d7910010a (hotel "Shehzad Ahmed Ghulam Muhammad")
--   -> f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2 (uber "Shehzad Ahmad Ghulam Muhammad") = 'shehzad ahmad ghulam muhammad'
--   verified 2026-09-03 on plate L46208
-- 6612891 (bolt "Shehzad Ahmed Ghulam Muhammad")
--   -> f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2 (uber,hotel "Shehzad Ahmad Ghulam Muhammad") = 'shehzad ahmad ghulam muhammad'
--   verified 2026-09-05 on 7 shared plates
-- 6598721, 67483c64055e070d791000d2 (bolt "Raja Aliyan Khalil Raja Khalil Ahmed")
--   -> 5f16534e-68be-451b-b057-3e3d948e868b (uber,yango "Aliyan khalil") = 'aliyan khalil'
--   verified 2026-09-05 on 3 shared plates
-- 6611093, f09cb675-9984-4546-b109-1b141e8467be (bolt "Mohammed Hasan Tarek Chowdhury Anwar Hossain Chowdhury")
--   -> 455ab44a-21b8-4dfe-9cc7-de929e10adea (uber "Mohammed Hasan Chowdhury") = 'mohammed hasan chowdhury'
--   verified 2026-09-05 on 3 shared plates
-- 7416305, 6a423abb13880329d04e1999 (bolt,hotel "Bakht Zada Bakht Sharif")
--   -> a4d29a55-9597-4a51-b5a1-19e449f239b6 (uber "Bakht Zada Sharif") = 'bakht zada sharif'
--   verified 2026-09-05 on 2 shared plates
-- 689df8813c9838d4b3a6d590, 7749606 (hotel,bolt "Shah Khalid Fayaz Ul Haq")
--   -> b226df8e-d251-47ce-9654-a86e009cfbf0 (uber "Shah Khalid Ul Haq") = 'shah khalid ul haq'
--   verified 2026-09-05 on 2 shared plates
-- 6623671, 67483c64055e070d791000d1 (bolt,hotel "Hamza Rizwan Tanveer Ahmed")
--   -> aeedc098-28fa-4d66-9c93-10a5d5cb34e8 (uber "Hamza Rizwan Ahmed") = 'hamza rizwan ahmed'
--   verified 2026-09-05 on 5 shared plates
-- 6615869, 67483c64055e070d79100119 (bolt "Muhammad Ashraf Ellahi Bakhsh")
--   -> f162cd70-310a-475a-b21f-55a7eafffaf4 (uber "Muhammad Ashraf Bakhsh") = 'muhammad ashraf bakhsh'
--   verified 2026-09-05 on 5 shared plates
-- 7842555, 6429fe4e-efae-43c8-94a2-09088d22993d (bolt "Rashid Iqbal Dost Muhammad")
--   -> 5cf88be8-3b56-4b31-9174-6d4dc0c12cae (uber "Rashid Iqbal Muhammad") = 'rashid iqbal muhammad'
--   verified 2026-09-05 on 1 shared plate
-- 7196091, 67483c64055e070d7910011b (bolt "Atif Khan Karim Khan")
--   -> 8010cb10-421a-498a-bad4-236c1731d887 (uber "Atif Khan Khan") = 'atif khan'
--   verified 2026-09-05 on 5 shared plates
-- 6585207, 936e2fba-63a9-4d3e-9b93-0368e028e0fb (bolt "Mohammed Selim Miah Shafiqur Rahman")
--   -> 0a6eb545-aa3b-4441-882c-34204df3d451 (uber "Mohammed Selim Shafiqur Rahman") = 'mohammed selim shafiqur rahman'
--   verified 2026-09-05 on 6 shared plates
-- 6781868, 67483c64055e070d7910011f (bolt,hotel "Noor Zaman Qaam Shah")
--   -> 2e513517-3ba0-48e8-9349-3885724c4505 (uber "Noor Zaman Shah") = 'noor zaman shah'
--   verified 2026-09-05 on 6 shared plates
-- 6611156, c89b7bc2-e3ff-468f-b84a-f258628d4edc (bolt "Nalini Chakrapani Giri Chakrapani")
--   -> e5ab224b-734b-42db-9163-fbe11b70517c (uber "Nalini Chakrapani Chakrapani") = 'nalini chakrapani'
--   verified 2026-09-05 on 2 shared plates
-- 8000520, 40d9e2c4-b309-4cad-aa45-111529001b0b (bolt "Muhammad Mussa Haji Alif Jhang")
--   -> 5e51b1a2-815b-457e-9c5f-7bbdf1ec2dba (uber "Muhammad Mussa Jhang") = 'muhammad mussa jhang'
--   verified 2026-09-05 on 3 shared plates
-- 6610938 (bolt "Wisal Muhammad Irshah Muhammad")
--   -> 64686123-8389-4a9e-82f1-0287e936239b (uber "Wisal Muhammad Muhammad") = 'wisal muhammad'
--   verified 2026-09-05 on 3 shared plates
-- 7554575 (bolt "Najeeb Ullah Khan Sabeel Khan")
--   -> 00b3e873-1399-4db2-a781-1eb432fd8b9f (uber "Najeeb Ullah Khan Khan") = 'najeeb ullah khan'
--   verified 2026-09-05 on 1 shared plate
-- 7490578 (bolt "Shahab Ali Shaukat Hayat")
--   -> 05a7d342-a3f9-4343-b8a5-89c72f0d87aa (uber "Shahab Ali Hayat") = 'shahab ali hayat'
--   verified 2026-09-05 on 1 shared plate
-- 6620276, 67483c64055e070d791000ea (bolt,hotel "Asad Khan Hakim Khan")
--   -> 0dcd3bb3-ed9b-41d2-a392-ac272bfe9e9d (uber "Asad Khan Khan") = 'asad khan'
--   verified 2026-09-05 on 3 shared plates
-- 6615016, 67483c64055e070d79100130 (bolt,hotel "Md Mahmudul Hasan")
--   -> 86e2349e-e8cd-41b0-8712-3591d46f9c64 (uber "Md muhmudul Hasan") = 'md muhmudul hasan'
--   verified 2026-09-05 on 4 shared plates
-- 7841816, f3aded68-1b7d-4903-9837-2a6981e83083 (bolt "Muhammad Nazir Zarin Khan")
--   -> cc12b6f3-7ce0-4dae-afcd-4454dd36a401 (uber "Muhammad Nazir Khan") = 'muhammad nazir khan'
--   verified 2026-09-05 on 1 shared plate
-- 8196123, 74eac830-64ff-4ca6-8902-f8342805ef4d (bolt "Mehran Said Ihsan Ghani")
--   -> 8978cc79-d8f7-4e0f-acd1-9c94953545bc (uber "Mehran Said Ghani") = 'mehran said ghani'
--   verified 2026-09-05 on 3 shared plates
-- 6616272, 67483c64055e070d791000f4 (bolt,hotel "Zahid Khan Afridi Mohabbat Khan")
--   -> c33cc3d6-77d2-4e13-a916-f08a89daf2bb (uber "Zahid Khan Khan") = 'zahid khan'
--   verified 2026-09-05 on 6 shared plates
-- 8240779, decaa9ec-2f1a-483f-8be5-62f48f97b887 (bolt "Muhammad Touseef Shakeel Muhammad Bangash")
--   -> 81cf7546-94b0-43ab-8952-cc3fbb7b88f2 (uber "Muhammad Toussef Bangash") = 'muhammad toussef bangash'
--   verified 2026-09-05 on 3 shared plates
-- 8326835, 693a7a9f8c482942eaaec5c0 (bolt "Ahmed Tarig Suliman Mohamed")
--   -> 7411d0fa-79c4-4b79-a3a6-f870948c1f7e (uber "Ahmed Tarig Mohamed") = 'ahmed tarig mohamed'
--   verified 2026-09-05 on 2 shared plates
-- 8362618, 6940219e8c482942eaaeffbe (bolt,hotel "Imran Hussain Muhammad Islam")
--   -> db0ba25e-4170-4fb3-a705-7a115875ac4f (uber "Imran Hussain Islam") = 'imran hussain islam'
--   verified 2026-09-05 on 4 shared plates
-- 7399836, 5d8e0b4033cf40f9943b5209b6e35341, 69b9815fcc90e854f1e5171c (bolt "Ijaz Ahmad Ashiq Khan")
--   -> d144a02a-3154-4042-8dff-68f4d4c69c58 (uber "Ijaz Ahmed Khan") = 'ijaz ahmed khan'
--   verified 2026-09-05 on 2 shared plates
-- 8483922, a41efffe-2f84-43ad-8f92-f50f755a1d55 (bolt "Bashir Ahmad")
--   -> 369dd9c1-ae0a-4526-8d46-d91a8c217121 (uber "Bashir Ahmad Amin") = 'bashir ahmad amin'
--   verified 2026-09-05 on 3 shared plates
-- 6610649, 67483c64055e070d791000dd (bolt,hotel "Fahad Ali Amjad Ali")
--   -> ec17d708-7879-42fc-90ec-6d19f01677fb (uber "Fahad Ali Ali") = 'fahad ali'
--   verified 2026-09-05 on 2 shared plates
-- 7009554, 67483c64055e070d791000e7 (bolt "Faiz Muhammad Nazar Muhammad")
--   -> b8bbe67f-ce9f-4e76-bd86-406b7c80b007 (uber "Faiz Muhammad Muhammad") = 'faiz muhammad'
--   verified 2026-09-05 on 5 shared plates
-- 7547646, 68766d2903051f14d95a8202 (bolt,hotel "Umair Khan Muzamil Shah")
--   -> 5b00efc9-f834-484e-93c2-552dd234de98 (uber "Umair Khan Shah") = 'umair khan shah'
--   verified 2026-09-05 on 5 shared plates
-- 6623895 (bolt "Md Anwar Hossain Md Abdul Kader Jelany Anwar Hossain Md Abdul Kader Jelany")
--   -> 73a665de-dd27-4c8b-a6ff-6c565cfe6116 (uber "Md Anwar Jelany") = 'md anwar jelany'
--   verified 2026-09-05 on 3 shared plates
-- 8773066 (bolt "SIMON LEONARD SANMOCTE MIRANO")
--   -> af95b655-7caf-43d5-920b-3ad907bbb3fb (uber "Simon Leonard Mirano") = 'simon leonard mirano'
--   verified 2026-09-05 on 1 shared plate
-- 8636674, 9b2a5734-0272-44d8-bb0b-48d73fe82b3d (bolt "Muhammad Tayyab Karamat Hussain")
--   -> c2470970-75a8-44d4-af6c-a3237ac73908 (uber "Muhammad Tayyab Hussain") = 'muhammad tayyab hussain'
--   verified 2026-09-05 on 1 shared plate
-- 7633809 (bolt "Raja Nouman Khalil Raja Khalil Ahmed")
--   -> 37723dc3-b5f7-49ce-9c80-495bf5a2b49b (uber "Raja Nouman Ahmed") = 'raja nouman ahmed'
--   verified 2026-09-05 on 1 shared plate
-- 6623737, 67483c64055e070d791000f2 (bolt "MUHAMMAD KHALID YOUNAS GUL")
--   -> 4d4eb2c1-f64c-48c2-8167-32d887cecfd2 (uber "Muhammad Khalid Gul") = 'muhammad khalid gul'
--   verified 2026-09-05 on 4 shared plates
-- 8658459, a37d36e7-75e6-4aeb-a093-faf9111d11c7 (bolt "Adnan Ahmad Khan Maidet Khan")
--   -> 5b7928cd-4843-4b28-8b3e-8085a10ee04c (uber "Adnan Ahmad khan") = 'adnan ahmad khan'
--   verified 2026-09-05 on 2 shared plates
-- 6633453, 67483c64055e070d791000ed (bolt "Hamza Khan Naeem Khan")
--   -> 12293989-e71b-4ff1-9e99-85274479fab1 (uber "Hamza Khan Khan") = 'hamza khan'
--   verified 2026-09-05 on 4 shared plates
-- 9065412, 6a18233a284c6a435463e10a (bolt "Anoj Gautam Mohan Bahadur")
--   -> c09bfab8-613d-45f6-9ceb-79d635805f60 (uber "Anoj Gautam") = 'anoj gautam'
--   verified 2026-09-05 on 3 shared plates
-- 6623877, 67483c64055e070d791000f3 (bolt,hotel "Muhammad Naseem Khan Muhammad Sadiq")
--   -> 06ff6c9d-f076-4b33-8240-f1c2ed3bf215 (uber "Muhammad Naseem Sadiq") = 'muhammad naseem sadiq'
--   verified 2026-09-05 on 2 shared plates
-- 9374689, 6a7ac834d87732ee9b1fb6e1 (bolt,hotel "Syed Arshad Abbas Naqvi Syed Imdad Hussain shah")
--   -> 9c0d754c-18cc-4998-9a07-d527a509236d (uber "Syed Arshad Shah") = 'syed arshad shah'
--   verified 2026-09-05 on 1 shared plate
-- 7883474, 98c7a061-d9f3-4e14-95ec-7eecec823af2 (bolt "Zohaib Khan Muhammad Usman")
--   -> 9950b892-52b1-487f-a8a3-31a31e491986 (uber "Zohaib Khan Usman") = 'zohaib khan usman'
--   verified 2026-09-05 on 2 shared plates
-- 8789306, 67483c64055e070d791000ec (bolt,hotel "ALI REHMAN RIAZ KARIM")
--   -> ae28ff72-760c-4259-815a-6c9fef953d46 (uber "Ali Rahman Karim") = 'ali rahman karim'
--   verified 2026-09-05 on 1 shared plate
-- 9120542, 26d509ca-2716-4dbc-9286-95e4640f33ef (bolt "Muhammad Sheraz Amir Muhammad")
--   -> d4862a73-6317-4fa8-ad19-8c7a95e9e74d (uber "Muhammad sheraz Muhammad") = 'muhammad sheraz muhammad'
--   verified 2026-09-05 on 1 shared plate
-- 67483c64055e070d791000d4 (hotel "MD ANWAR HOSSAIN MD ABDUL KADER JELANY")
--   -> 73a665de-dd27-4c8b-a6ff-6c565cfe6116 (uber "Md Anwar Jelany") = 'md anwar jelany'
--   verified 2026-09-05 on 1 shared plate
-- 9593757, 292b8810-08ef-4305-8374-759af09384b3 (bolt "Muhammed nabeel Thotty abdulkhader ABD")
--   -> 03327ed4-85eb-4573-bdcd-03d79f308ac7 (uber "Muhammed Nabeel Thotty") = 'muhammed nabeel thotty'
--   verified 2026-09-05 on 1 shared plate
-- 6a4f617fb3b4e99c0391a663 (hotel "Rana jahanzaib Akbar Muhammad Akbar")
--   -> 41e79149-9b9b-4c04-a3d9-5677be879ddd (uber,bolt "Rana Jahanzaib Akbar") = 'rana jahanzaib akbar'
--   verified 2026-09-05 on 1 shared plate
-- 6a5645c839f87dec92ca9386 (hotel "Abidullah Safi")
--   -> dae09063-88a3-432e-b39f-969d8de7992b (uber "Abidullah Safi") = 'abidullah safi'
--   verified 2026-09-07 on a shared phone
-- beada3aa-c836-47d2-9100-feea4b1f31e2 (uber "Abusaad Siddiqui Ahmad")
--   -> 68f744f88c482942eaaba18b (hotel "Abusaad Siddiqui Akhlaque Ahmad") = 'abusaad siddiqui akhlaque ahmad'
--   verified 2026-09-07 on a shared phone
-- 78b5741e-1c72-4b56-907f-da18807e5f57 (uber "Aftab Ahmed Altaf")
--   -> 68905c41d0a931b9d7544982 (hotel "Aftab Ahmed Muhammad Sharif Altaf") = 'aftab ahmed muhammad sharif altaf'
--   verified 2026-09-07 on a shared phone
-- 69707aaeb905b635fcc054f3 (hotel "Alakbar Rahimov")
--   -> cf08a7df-1a9f-450c-92aa-baa8d9da5f7b (uber "ALAKBAR RAHIMOV") = 'alakbar rahimov'
--   verified 2026-09-07 on a shared phone
-- 42114339-fce7-448d-a4b5-b22aeea680cf (uber "Ali Nawaz Nawaz")
--   -> 67483c64055e070d791000f0 (hotel "ALI NAWAZ MUHAMMAD NAWAZ") = 'ali nawaz muhammad nawaz'
--   verified 2026-09-07 on a shared phone
-- 41b08fe8-4e12-4541-bb74-51c44bd54357 (uber "Amanullah Alam")
--   -> 68766d7d03051f14d95a8209 (hotel "Aman Ullah Amir Mehboob Alam") = 'aman ullah amir mehboob alam'
--   verified 2026-09-07 on a shared phone
-- 9c09415b-9aa2-43dc-ac9e-298c3c72ac32 (uber "Amshid Khan Khan")
--   -> 67483c64055e070d791000e5 (hotel "AMSHID KHAN ALEEM KHAN") = 'amshid khan aleem khan'
--   verified 2026-09-07 on a shared phone
-- 84dea951-8a05-4b19-8b88-072ac72f3d2c (uber "Ansar Murtaza Butt")
--   -> 67483c64055e070d791000e0 (hotel "ANSAR MURTAZA BUTT RASHID MURTAZA") = 'ansar murtaza butt rashid murtaza'
--   verified 2026-09-07 on a shared phone
-- 513d8c27-b88d-4c3e-8b20-c74680dede03 (uber "Edwin Mandere")
--   -> 6a48ed8f13880329d04ebbbd (hotel "Edwin Nyasani Mandere") = 'edwin nyasani mandere'
--   verified 2026-09-07 on a shared phone
-- 9d1c60ce-e906-4ce7-ac3f-dd33eed89c99 (uber "Faisal Badshah Badshah")
--   -> 67483c64055e070d79100109 (hotel "FAISAL BADSHAH RASOOL BADSHAH") = 'faisal badshah rasool badshah'
--   verified 2026-09-07 on a shared phone
-- 690b535b8c482942eaacb83c (hotel "Farman Ullah Ghafoor Khan")
--   -> de9a4044-c57e-427c-ae06-5bca66873857 (uber "Farman Ullah Ghafoor Khan") = 'farman ullah ghafoor khan'
--   verified 2026-09-07 on a shared phone
-- df270275-028d-40e7-91c8-5f3b80e3efed (uber "Fawad Ali Muhammad")
--   -> 67483c64055e070d791000d0 (hotel "FAWAD ALI KHAN AYAZ MUHAMMAD") = 'fawad ali khan ayaz muhammad'
--   verified 2026-09-07 on a shared phone
-- 69046cc38c482942eaac6ee7 (hotel "Hassan Talaat Kamel Abousira")
--   -> 293f7986-1768-4c56-8317-133ee31d89fb (uber "Hassan Talaat Kamel Abousira") = 'hassan talaat kamel abousira'
--   verified 2026-09-07 on a shared phone
-- 67483c64055e070d791000f1 (hotel "IRFAN ULLAH AWAL AMEEN")
--   -> 04c30a0a-1d4f-40f3-b9aa-378ed5ceeee4 (uber "Irfan Ullah Awal Ameen") = 'irfan ullah awal ameen'
--   verified 2026-09-07 on a shared phone
-- 68e368e3ff76a73626e0720e (hotel "Joseph Wandera")
--   -> 1e2311ad-cc26-4e2b-839a-41363ef67672 (uber "Joseph Wandera") = 'joseph wandera'
--   verified 2026-09-07 on a shared phone
-- ec9980b3-9663-43ac-9444-a1fc81675c0a (uber "Kashan Malik Malik")
--   -> 67483c64055e070d791000fc (hotel "KASHAN MALIK ABDUL MALIK") = 'kashan malik abdul malik'
--   verified 2026-09-07 on a shared phone
-- 67483c64055e070d791000e3 (hotel "KASHIF ALI AYYUB KHAN")
--   -> 84d498cf-a74a-4750-9ac2-5eabdeec3b8d (uber "Kashif Ali Ayyub khan") = 'kashif ali ayyub khan'
--   verified 2026-09-07 on a shared phone
-- 8cf0d6e0-5399-4686-81fd-2aa8682ce786 (uber "Kazi Fuad Alim Ullah")
--   -> 67483c64055e070d791000ca (hotel "Kazi Fuad Ahmed Kazi Alim Ullah") = 'kazi fuad ahmed kazi alim ullah'
--   verified 2026-09-07 on a shared phone
-- 4963067e-9979-411e-8c66-926ca581a0f2 (uber "Majid Shah Shah")
--   -> 67483c64055e070d791000ee (hotel "MAJID SHAH MEHBOOB SHAH") = 'majid shah mehboob shah'
--   verified 2026-09-07 on a shared phone
-- 7edf1e96-da02-4f5a-ae10-5b9a1842c828 (uber "Md Imran Mostafa")
--   -> 67483c64055e070d7910012e (hotel "Md Imran Hasan Rahi Md Mostafa") = 'md imran hasan rahi md mostafa'
--   verified 2026-09-07 on a shared phone
-- e4cb0cd6-a078-461b-984a-b7c6fc32a247 (uber "M Maen Shekfa")
--   -> 67483c64055e070d79100133 (hotel "M MAEN M ALAA SHEKFA") = 'maen m alaa shekfa'
--   verified 2026-09-07 on a shared phone
-- d31e25fa-dc28-424c-a6e5-c2cbcf516870 (uber "Mohammad Naeem Khan")
--   -> 67483c64055e070d79100117 (hotel "MOHAMMAD NAEEM ADAM KHAN") = 'mohammad naeem adam khan'
--   verified 2026-09-07 on a shared phone
-- 47f7edb9-b533-45b9-8f42-2f383b8384bb (uber "Mohammad Shahin Shahazanan")
--   -> 67483c64055e070d79100129 (hotel "Mohammad Shahin Mohammad Shahazanan") = 'mohammad shahin mohammad shahazanan'
--   verified 2026-09-07 on a shared phone
-- ba5e864f-6035-469c-97a1-db3e4a087385 (uber "Mohammed Alsous")
--   -> 67483c64055e070d7910012f (hotel "MOHAMMED A A ALSOOS") = 'mohammed alsoos'
--   verified 2026-09-07 on a shared phone
-- 68905130d0a931b9d7544863 (hotel "Mohammed Musab Rahmathulla")
--   -> 2c085db3-dbb1-48a6-99ca-0af7e5ee3ea5 (uber "Mohammed Musab Rahmathulla") = 'mohammed musab rahmathulla'
--   verified 2026-09-07 on a shared phone
-- 68e36905ff76a73626e07220 (hotel "Moses Bale")
--   -> 628fbdea-1404-4289-a5b5-9bab4dc69cf0 (uber "Moses Bale") = 'moses bale'
--   verified 2026-09-07 on a shared phone
-- 0b4d7f5b-086e-4f40-96c6-2e2ffe727214 (uber "Muhammad Abid Khan")
--   -> 67483c64055e070d791000de (hotel "MUHAMMAD ABID ALI KHAN NOOR NOOR") = 'muhammad abid ali khan noor'
--   verified 2026-09-07 on a shared phone
-- 8b6b8f45-eda3-44be-85d8-0d45d9dad64e (uber "Muhammad Ahmad khan")
--   -> 6a7f3e80d87732ee9b2068a3 (hotel "MUHAMMAD AHMAD GHULAM QADIR") = 'muhammad ahmad ghulam qadir'
--   verified 2026-09-07 on a shared phone
-- b00986ad-2af2-4fac-babd-df87d3cd5a05 (uber "Muhammad Amir Khan")
--   -> 67483c64055e070d791000d3 (hotel "MUHAMMAD AMIR MISREE KHAN") = 'muhammad amir misree khan'
--   verified 2026-09-07 on a shared phone
-- 3113020f-f05b-4f77-882b-394cce34efc7 (uber "Muhammad Hanan Munir")
--   -> 688085f5a0bf23d354fd60b0 (hotel "Muhammad Hanan Munir Muhammad Munir") = 'muhammad hanan munir muhammad munir'
--   verified 2026-09-07 on a shared phone
-- 147935b6-3c73-4689-a5f2-3efd07d91c12 (uber "Muhammad Hasham KHAN")
--   -> 67483c64055e070d791000e2 (hotel "MUHAMMAD HASHAM TANVEER TANVEER AHMAD KHAN") = 'muhammad hasham tanveer ahmad khan'
--   verified 2026-09-07 on a shared phone
-- 76ede4ae-768b-4126-804b-0b5c88043682 (uber "Muhammad Khalid")
--   -> 67483c64055e070d79100112 (hotel "MUHAMMAD KHALIFA AFZAL KHALID") = 'muhammad khalifa afzal khalid'
--   verified 2026-09-07 on a shared phone
-- 1f5bbf3c-ba34-4dec-a28a-6af17d241033 (uber "Muhammad Sameer Asghar")
--   -> 67483c64055e070d79100131 (hotel "MUHAMMAD SAMEER SHAMREZ ASGHAR") = 'muhammad sameer shamrez asghar'
--   verified 2026-09-07 on a shared phone
-- 8583f89a-6620-4557-a985-4c12bf08b02a (uber "Nauman Hassan Muhammad")
--   -> 67483c64055e070d791000f9 (hotel "NAUMAN HASSAN SHIDA MUHAMMAD") = 'nauman hassan shida muhammad'
--   verified 2026-09-07 on a shared phone
-- 6a18229d284c6a435463e0fb (hotel "Norah chia Nsom")
--   -> 8daae9c7-5a34-4e67-a178-565b92191461 (uber "Norah Chia Nsom") = 'norah chia nsom'
--   verified 2026-09-07 on a shared phone
-- 69845f36-babb-46b3-ae7d-d39c864bc427 (uber "Saad ali Bhatti")
--   -> 67483c64055e070d791000d9 (hotel "SAAD ALI AKRAM MUHAMMAD AKRAM BHATTI") = 'saad ali akram muhammad akram bhatti'
--   verified 2026-09-07 on a shared phone
-- 67483c64055e070d791000cd (hotel "SABBIR HOSSAIN SHAHALOM")
--   -> 006e7f5c-f7c4-45f2-bd00-336121105d3f (uber "Sabbir Hossain Shahalom") = 'sabbir hossain shahalom'
--   verified 2026-09-07 on a shared phone
-- a2692332-5580-4aef-890b-48416e7eeed0 (uber "Sajid Gul Muhammad")
--   -> 68905711d0a931b9d754492a (hotel "Sajid Gul Gul Muhammad") = 'sajid gul muhammad'
--   verified 2026-09-07 on a shared phone
-- 14852992-6178-4043-976e-4dd4e8fc72ad (uber "Sar Zamin Bahadar")
--   -> 69411d3a8c482942eaaf083e (hotel "Sar Zamin Khan Shah Bahadar") = 'sar zamin khan shah bahadar'
--   verified 2026-09-07 on a shared phone
-- 69a6b3ea0c67e9caa6353337 (hotel "Sohib Hussein Ahmed")
--   -> 99c3016d-12da-4831-a4c6-7102c696b849 (uber "Sohib Hussein Mohamed") = 'sohib hussein mohamed'
--   verified 2026-09-07 on a shared phone
-- 758b9949-6042-4c2d-b6f0-aebe8501d5be (uber "Umar Ali Khan")
--   -> 67483c64055e070d791000f8 (hotel "Umar Ali Zarid Khan") = 'umar ali zarid khan'
--   verified 2026-09-07 on a shared phone
-- 4056c8cc-3c12-41ba-9948-e7e740d67fbe (uber "Waseem Abbas Nabi")
--   -> 6911c82f8c482942eaacf939 (hotel "Waseem Abbas Ghulam Nabi") = 'waseem abbas ghulam nabi'
--   verified 2026-09-07 on a shared phone
-- 362aca28-e48d-4c09-bce2-f5fe23266723 (uber "Zain Ul Abideen Irfan")
--   -> 67483c64055e070d791000df (hotel "ZAIN UL ABIDEEN MUHAMMAD IRFAN") = 'zain ul abideen muhammad irfan'
--   verified 2026-09-07 on a shared phone
-- 4ce6eea7-ea84-49d9-b6c5-14f67d3f5cc3 (uber "Zia Ali Muhammad")
--   -> 67483c64055e070d7910012d (hotel "ZIA ALI SAID MUHAMMAD") = 'zia ali said muhammad'
--   verified 2026-09-07 on a shared phone
-- a83f63fc-88bb-4bbd-9ee3-55d5aeb00e8c (uber "Zubair Khan Ali")
--   -> 67483c64055e070d791000e4 (hotel "ZUBAIR KHAN SHAUKAT ALI") = 'zubair khan shaukat ali'
--   verified 2026-09-07 on a shared phone
--
-- The canonical key of each pair is the folded name of the SURVIVING record,
-- unchanged. No key in this database moves except the alias record's, which
-- moves onto the survivor — so the migration merges work together and renames
-- nobody.
--
-- ── why the column is dropped and re-added ─────────────────────────────────
-- Postgres 16 has no ALTER COLUMN ... SET EXPRESSION (that arrived in 17), so a
-- generated column's expression can only be replaced by replacing the column.
-- Dropping it takes its indexes with it — including trip_econ_day_idx from
-- sql/schema_v30.sql, which carries person_key in its INCLUDE list — and every
-- one of them is recreated at the bottom of this file, verbatim from the file
-- that owns it. The guard below skips the rebuild once the expression is
-- already in place, so a re-run costs one catalogue lookup per table instead of
-- a rewrite of the trip table.

DO $mig$
DECLARE
  t   record;
  tpl text := $tpl$CASE driver_ext_id
         WHEN '7fc8da91fc4a44c185e8d6d918db3e6b' THEN 'aliyan khalil'
         WHEN 'ab2aec60-56ff-48e2-85c0-3591f6f29aa3' THEN 'moses arthur'
         WHEN '67483c64055e070d7910010a' THEN 'shehzad ahmad ghulam muhammad'
         WHEN '6612891' THEN 'shehzad ahmad ghulam muhammad'
         WHEN '6598721' THEN 'aliyan khalil'
         WHEN '67483c64055e070d791000d2' THEN 'aliyan khalil'
         WHEN '6611093' THEN 'mohammed hasan chowdhury'
         WHEN 'f09cb675-9984-4546-b109-1b141e8467be' THEN 'mohammed hasan chowdhury'
         WHEN '7416305' THEN 'bakht zada sharif'
         WHEN '6a423abb13880329d04e1999' THEN 'bakht zada sharif'
         WHEN '689df8813c9838d4b3a6d590' THEN 'shah khalid ul haq'
         WHEN '7749606' THEN 'shah khalid ul haq'
         WHEN '6623671' THEN 'hamza rizwan ahmed'
         WHEN '67483c64055e070d791000d1' THEN 'hamza rizwan ahmed'
         WHEN '6615869' THEN 'muhammad ashraf bakhsh'
         WHEN '67483c64055e070d79100119' THEN 'muhammad ashraf bakhsh'
         WHEN '7842555' THEN 'rashid iqbal muhammad'
         WHEN '6429fe4e-efae-43c8-94a2-09088d22993d' THEN 'rashid iqbal muhammad'
         WHEN '7196091' THEN 'atif khan'
         WHEN '67483c64055e070d7910011b' THEN 'atif khan'
         WHEN '6585207' THEN 'mohammed selim shafiqur rahman'
         WHEN '936e2fba-63a9-4d3e-9b93-0368e028e0fb' THEN 'mohammed selim shafiqur rahman'
         WHEN '6781868' THEN 'noor zaman shah'
         WHEN '67483c64055e070d7910011f' THEN 'noor zaman shah'
         WHEN '6611156' THEN 'nalini chakrapani'
         WHEN 'c89b7bc2-e3ff-468f-b84a-f258628d4edc' THEN 'nalini chakrapani'
         WHEN '8000520' THEN 'muhammad mussa jhang'
         WHEN '40d9e2c4-b309-4cad-aa45-111529001b0b' THEN 'muhammad mussa jhang'
         WHEN '6610938' THEN 'wisal muhammad'
         WHEN '7554575' THEN 'najeeb ullah khan'
         WHEN '7490578' THEN 'shahab ali hayat'
         WHEN '6620276' THEN 'asad khan'
         WHEN '67483c64055e070d791000ea' THEN 'asad khan'
         WHEN '6615016' THEN 'md muhmudul hasan'
         WHEN '67483c64055e070d79100130' THEN 'md muhmudul hasan'
         WHEN '7841816' THEN 'muhammad nazir khan'
         WHEN 'f3aded68-1b7d-4903-9837-2a6981e83083' THEN 'muhammad nazir khan'
         WHEN '8196123' THEN 'mehran said ghani'
         WHEN '74eac830-64ff-4ca6-8902-f8342805ef4d' THEN 'mehran said ghani'
         WHEN '6616272' THEN 'zahid khan'
         WHEN '67483c64055e070d791000f4' THEN 'zahid khan'
         WHEN '8240779' THEN 'muhammad toussef bangash'
         WHEN 'decaa9ec-2f1a-483f-8be5-62f48f97b887' THEN 'muhammad toussef bangash'
         WHEN '8326835' THEN 'ahmed tarig mohamed'
         WHEN '693a7a9f8c482942eaaec5c0' THEN 'ahmed tarig mohamed'
         WHEN '8362618' THEN 'imran hussain islam'
         WHEN '6940219e8c482942eaaeffbe' THEN 'imran hussain islam'
         WHEN '7399836' THEN 'ijaz ahmed khan'
         WHEN '5d8e0b4033cf40f9943b5209b6e35341' THEN 'ijaz ahmed khan'
         WHEN '69b9815fcc90e854f1e5171c' THEN 'ijaz ahmed khan'
         WHEN '8483922' THEN 'bashir ahmad amin'
         WHEN 'a41efffe-2f84-43ad-8f92-f50f755a1d55' THEN 'bashir ahmad amin'
         WHEN '6610649' THEN 'fahad ali'
         WHEN '67483c64055e070d791000dd' THEN 'fahad ali'
         WHEN '7009554' THEN 'faiz muhammad'
         WHEN '67483c64055e070d791000e7' THEN 'faiz muhammad'
         WHEN '7547646' THEN 'umair khan shah'
         WHEN '68766d2903051f14d95a8202' THEN 'umair khan shah'
         WHEN '6623895' THEN 'md anwar jelany'
         WHEN '8773066' THEN 'simon leonard mirano'
         WHEN '8636674' THEN 'muhammad tayyab hussain'
         WHEN '9b2a5734-0272-44d8-bb0b-48d73fe82b3d' THEN 'muhammad tayyab hussain'
         WHEN '7633809' THEN 'raja nouman ahmed'
         WHEN '6623737' THEN 'muhammad khalid gul'
         WHEN '67483c64055e070d791000f2' THEN 'muhammad khalid gul'
         WHEN '8658459' THEN 'adnan ahmad khan'
         WHEN 'a37d36e7-75e6-4aeb-a093-faf9111d11c7' THEN 'adnan ahmad khan'
         WHEN '6633453' THEN 'hamza khan'
         WHEN '67483c64055e070d791000ed' THEN 'hamza khan'
         WHEN '9065412' THEN 'anoj gautam'
         WHEN '6a18233a284c6a435463e10a' THEN 'anoj gautam'
         WHEN '6623877' THEN 'muhammad naseem sadiq'
         WHEN '67483c64055e070d791000f3' THEN 'muhammad naseem sadiq'
         WHEN '9374689' THEN 'syed arshad shah'
         WHEN '6a7ac834d87732ee9b1fb6e1' THEN 'syed arshad shah'
         WHEN '7883474' THEN 'zohaib khan usman'
         WHEN '98c7a061-d9f3-4e14-95ec-7eecec823af2' THEN 'zohaib khan usman'
         WHEN '8789306' THEN 'ali rahman karim'
         WHEN '67483c64055e070d791000ec' THEN 'ali rahman karim'
         WHEN '9120542' THEN 'muhammad sheraz muhammad'
         WHEN '26d509ca-2716-4dbc-9286-95e4640f33ef' THEN 'muhammad sheraz muhammad'
         WHEN '67483c64055e070d791000d4' THEN 'md anwar jelany'
         WHEN '9593757' THEN 'muhammed nabeel thotty'
         WHEN '292b8810-08ef-4305-8374-759af09384b3' THEN 'muhammed nabeel thotty'
         WHEN '6a4f617fb3b4e99c0391a663' THEN 'rana jahanzaib akbar'
         WHEN '6a5645c839f87dec92ca9386' THEN 'abidullah safi'
         WHEN 'beada3aa-c836-47d2-9100-feea4b1f31e2' THEN 'abusaad siddiqui akhlaque ahmad'
         WHEN '78b5741e-1c72-4b56-907f-da18807e5f57' THEN 'aftab ahmed muhammad sharif altaf'
         WHEN '69707aaeb905b635fcc054f3' THEN 'alakbar rahimov'
         WHEN '42114339-fce7-448d-a4b5-b22aeea680cf' THEN 'ali nawaz muhammad nawaz'
         WHEN '41b08fe8-4e12-4541-bb74-51c44bd54357' THEN 'aman ullah amir mehboob alam'
         WHEN '9c09415b-9aa2-43dc-ac9e-298c3c72ac32' THEN 'amshid khan aleem khan'
         WHEN '84dea951-8a05-4b19-8b88-072ac72f3d2c' THEN 'ansar murtaza butt rashid murtaza'
         WHEN '513d8c27-b88d-4c3e-8b20-c74680dede03' THEN 'edwin nyasani mandere'
         WHEN '9d1c60ce-e906-4ce7-ac3f-dd33eed89c99' THEN 'faisal badshah rasool badshah'
         WHEN '690b535b8c482942eaacb83c' THEN 'farman ullah ghafoor khan'
         WHEN 'df270275-028d-40e7-91c8-5f3b80e3efed' THEN 'fawad ali khan ayaz muhammad'
         WHEN '69046cc38c482942eaac6ee7' THEN 'hassan talaat kamel abousira'
         WHEN '67483c64055e070d791000f1' THEN 'irfan ullah awal ameen'
         WHEN '68e368e3ff76a73626e0720e' THEN 'joseph wandera'
         WHEN 'ec9980b3-9663-43ac-9444-a1fc81675c0a' THEN 'kashan malik abdul malik'
         WHEN '67483c64055e070d791000e3' THEN 'kashif ali ayyub khan'
         WHEN '8cf0d6e0-5399-4686-81fd-2aa8682ce786' THEN 'kazi fuad ahmed kazi alim ullah'
         WHEN '4963067e-9979-411e-8c66-926ca581a0f2' THEN 'majid shah mehboob shah'
         WHEN '7edf1e96-da02-4f5a-ae10-5b9a1842c828' THEN 'md imran hasan rahi md mostafa'
         WHEN 'e4cb0cd6-a078-461b-984a-b7c6fc32a247' THEN 'maen m alaa shekfa'
         WHEN 'd31e25fa-dc28-424c-a6e5-c2cbcf516870' THEN 'mohammad naeem adam khan'
         WHEN '47f7edb9-b533-45b9-8f42-2f383b8384bb' THEN 'mohammad shahin mohammad shahazanan'
         WHEN 'ba5e864f-6035-469c-97a1-db3e4a087385' THEN 'mohammed alsoos'
         WHEN '68905130d0a931b9d7544863' THEN 'mohammed musab rahmathulla'
         WHEN '68e36905ff76a73626e07220' THEN 'moses bale'
         WHEN '0b4d7f5b-086e-4f40-96c6-2e2ffe727214' THEN 'muhammad abid ali khan noor'
         WHEN '8b6b8f45-eda3-44be-85d8-0d45d9dad64e' THEN 'muhammad ahmad ghulam qadir'
         WHEN 'b00986ad-2af2-4fac-babd-df87d3cd5a05' THEN 'muhammad amir misree khan'
         WHEN '3113020f-f05b-4f77-882b-394cce34efc7' THEN 'muhammad hanan munir muhammad munir'
         WHEN '147935b6-3c73-4689-a5f2-3efd07d91c12' THEN 'muhammad hasham tanveer ahmad khan'
         WHEN '76ede4ae-768b-4126-804b-0b5c88043682' THEN 'muhammad khalifa afzal khalid'
         WHEN '1f5bbf3c-ba34-4dec-a28a-6af17d241033' THEN 'muhammad sameer shamrez asghar'
         WHEN '8583f89a-6620-4557-a985-4c12bf08b02a' THEN 'nauman hassan shida muhammad'
         WHEN '6a18229d284c6a435463e0fb' THEN 'norah chia nsom'
         WHEN '69845f36-babb-46b3-ae7d-d39c864bc427' THEN 'saad ali akram muhammad akram bhatti'
         WHEN '67483c64055e070d791000cd' THEN 'sabbir hossain shahalom'
         WHEN 'a2692332-5580-4aef-890b-48416e7eeed0' THEN 'sajid gul muhammad'
         WHEN '14852992-6178-4043-976e-4dd4e8fc72ad' THEN 'sar zamin khan shah bahadar'
         WHEN '69a6b3ea0c67e9caa6353337' THEN 'sohib hussein mohamed'
         WHEN '758b9949-6042-4c2d-b6f0-aebe8501d5be' THEN 'umar ali zarid khan'
         WHEN '4056c8cc-3c12-41ba-9948-e7e740d67fbe' THEN 'waseem abbas ghulam nabi'
         WHEN '362aca28-e48d-4c09-bce2-f5fe23266723' THEN 'zain ul abideen muhammad irfan'
         WHEN '4ce6eea7-ea84-49d9-b6c5-14f67d3f5cc3' THEN 'zia ali said muhammad'
         WHEN 'a83f63fc-88bb-4bbd-9ee3-55d5aeb00e8c' THEN 'zubair khan shaukat ali'
         ELSE regexp_replace(
             btrim(regexp_replace(lower(%I), '\s+', ' ', 'g')),
             '(\m\w+)( \1)+', '\1', 'g') END$tpl$;
BEGIN
  FOR t IN SELECT * FROM (VALUES
        ('trip',                 'driver_name'),
        ('driver_platform_state','full_name'),
        ('vehicle_driver_day',   'driver_name'),
        ('money_event',          'driver_name'),
        ('driver_statement_day', 'driver_name'),
        ('driver_payout_day',    'driver_name')
      ) v(tbl, namecol)
  LOOP
    -- A table this database has not built yet is not this file's business.
    CONTINUE WHEN to_regclass(t.tbl) IS NULL;
    -- Already carrying the register: nothing to do, and nothing to rewrite.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = current_schema()
         AND c.table_name   = t.tbl
         AND c.column_name  = 'person_key'
         AND c.generation_expression LIKE '%a83f63fc-88bb-4bbd-9ee3-55d5aeb00e8c%'
         -- …and carries as many merges as this register has, so a column built
         -- from a SUPERSET that happens to end on the same pair still rebuilds.
         AND (length(c.generation_expression)
              - length(replace(c.generation_expression, 'WHEN ', ''))) / 5 = 130);
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS person_key', t.tbl);
    EXECUTE format('ALTER TABLE %I ADD COLUMN person_key text GENERATED ALWAYS AS (%s) STORED',
                   t.tbl, format(tpl, t.namecol));
  END LOOP;
END
$mig$;

-- ── the indexes the drop took with it ──────────────────────────────────────
-- Partial on the same predicate as before: a row with no name has no person,
-- and an empty key must never become the bucket every anonymous row falls into.
CREATE INDEX IF NOT EXISTS trip_person_key_idx ON trip (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS dps_person_key_idx ON driver_platform_state (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS vdd_person_key_idx ON vehicle_driver_day (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS money_event_person_idx ON money_event (person_key)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS dsd_person_key_idx ON driver_statement_day (person_key, day)
  WHERE person_key IS NOT NULL AND person_key <> '';

CREATE INDEX IF NOT EXISTS dpd_person_key_idx ON driver_payout_day (person_key, day)
  WHERE person_key IS NOT NULL AND person_key <> '';

-- The covering index for the unit-economics window scan (sql/schema_v30.sql).
-- It INCLUDEs person_key, so dropping the column dropped it, and /api/economics
-- goes back to a heap fetch per row without it.
CREATE INDEX IF NOT EXISTS trip_econ_day_idx
  ON trip (((requested_at AT TIME ZONE 'Asia/Dubai')::date))
  INCLUDE (plate, platform, fleet_id, person_key, driver_ext_id, driver_name,
           status, payment_type, price, distance_km, requested_at);
