-- ── 460 people who were on the roster more than once, folded onto one key each ──
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
-- What is NOT here is any pair with a contradiction nobody has ruled on: a day
-- on which both records took a trip at the same time. 0 carry one, they stay
-- in PENDING, and a simultaneous trip outranks a shared phone every time.
-- What IS here despite one is a pair the operator ruled on over its
-- contradiction — 330 so far, marked "ruled" in the register below. A person
-- who knows the man outranks one feed row's vehicle field, and the ruling is
-- recorded in api/identity_map.js as a ruling, not as a measurement.
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
-- 67483c64055e070d79100114 (hotel "Sana Ullah Sher Zamin")
--   -> b7511fa7-cbdf-4373-8539-c7ae020c31e2 (uber "Sanaullah Sher Zamin") = 'sanaullah sher zamin'
--   verified 2026-09-22 on plate L20048
-- 6623821, b17bcd50-e20b-4055-80d8-468131188397 (bolt "Ali Abbas Faiz Ahmed")
--   -> 9e9060e7-0b8c-4f3b-8cd7-165d5eac55cd (uber "Ali Abbas Ahmed") = 'ali abbas ahmed'
--   verified 2026-09-29 on 3 shared plates; ruled by the operator 2026-09-29 over the contradiction of 2025-08-31
-- 67483c64055e070d791000cf, 6639200 (hotel,bolt "SOAIEED ALOM MIHIN JINNAT ALI")
--   -> fb7c2c86-4ba0-41d6-b73f-6e9dd77b08ff (uber "Soaieed Alom Ali") = 'soaieed alom ali'
--   verified 2026-10-08 on 5 shared plates; ruled by the operator 2026-10-08 over the contradiction of 2025-05-03
-- 6780293, 2a1d4e30-e10f-4f47-a610-faae8c94d125 (bolt "Fayed Ali Taj Muhammad")
--   -> cb5359cf-9f1f-4fcc-aee7-f79e892e78c7 (uber "Fayed Ali Muhammad") = 'fayed ali muhammad'
--   verified 2026-10-08 on 4 shared plates; ruled by the operator 2026-10-08 over the contradiction of 2025-12-21, 2025-12-23
-- 69f7e655aab1412c83a9c6d4d58aa122, 7308211 (yango,bolt "Tariq Afzal Said Afzal")
--   -> 7e96cb47-f2d4-4f96-9019-0ee79eb0117d (uber "Tariq Afzal Afzal") = 'tariq afzal'
--   verified 2026-10-08 on 2 shared plates; ruled by the operator 2026-10-08 over the contradiction of 2026-06-10
-- 7523458, 68766cd503051f14d95a81fb (bolt,hotel "Hammad Ahmad Aftab Ahmad")
--   -> d454e6b8-6d69-469e-91a5-37c174dac8fd (uber "Hammad Ahmad Ahmad") = 'hammad ahmad'
--   verified 2026-10-08 on 7 shared plates; ruled by the operator 2026-10-08 over the contradiction of 2025-07-02
-- 9c09415b-9aa2-43dc-ac9e-298c3c72ac32, 67483c64055e070d791000e5, 6633456 (uber,hotel,bolt "AMSHID KHAN ALEEM KHAN")
--   -> e6fd4328-b270-4e7e-bff8-2c6e0f290a28 (uber "Amshid Khan Khan") = 'amshid khan'
--   verified 2026-10-08; ruled by the operator 2026-10-08
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
-- 1d910e38d0a5451ea5b4c45df2706c5e (yango "AAMIR KHAN")
--   -> efa5df29-c8ac-47d7-9ce2-be046f5d3a0f (uber "Aamir Khan Amin") = 'aamir khan amin'
--   verified 2026-09-07 on a shared phone
-- 48de0d9f0a7c493f83724bae1f8dd257 (yango "Abdul Basit Aman")
--   -> 6d609028-a86c-4cee-92ef-7bae26e0cca8 (uber "Abdul Basit Aman") = 'abdul basit aman'
--   verified 2026-09-07 on a shared phone
-- 1427dd41041346988c05065cee86c47f (yango "ABDUL HANNAN")
--   -> 67483c64055e070d79100105 (hotel "ABDUL HANNAN MOMIN HUMAYOUN HABIB MOMIN") = 'abdul hannan momin humayoun habib momin'
--   verified 2026-09-07 on a shared phone
-- d5eb68b8397a449d82003ddf3faa52fa (yango "ABDULLAH AHMAD")
--   -> 67483c64055e070d7910010e (hotel "ABDULLAH AHMAD AHMAD ULLAH KHAN") = 'abdullah ahmad ullah khan'
--   verified 2026-09-07 on a shared phone
-- d6d4e1cb-296f-4ef5-8270-3653ef546a02 (uber "Abubakar Saddique Shah")
--   -> 5779be46aefa4bacaa413aa861219444 (yango "Abu Bakar Saddique Kamil Shah") = 'abu bakar saddique kamil shah'
--   verified 2026-09-07 on a shared phone
-- d694b0919c1d4b639642771c0119509e (yango "ALI REHMAN")
--   -> ae28ff72-760c-4259-815a-6c9fef953d46 (uber "Ali Rahman Karim") = 'ali rahman karim'
--   verified 2026-09-07 on a shared phone
-- d9b2de76-b535-4b23-a714-7e31724e50d2 (uber "Muhammad Naeem Khan")
--   -> 1ffc17512bae40d2a6899f35aad12789 (yango "Amir Muhammad Khan Muhammad Naeem Khan") = 'amir muhammad khan muhammad naeem khan'
--   verified 2026-09-07 on a shared phone
-- c7a289421a5848ee9bfacf71b133fc24 (yango "AMSHID KHAN")
--   -> e6fd4328-b270-4e7e-bff8-2c6e0f290a28 (uber "Amshid Khan Khan") = 'amshid khan'
--   verified 2026-09-07 on a shared phone
-- ca4b038d57a146698bca6c1b1e0a999a (yango "Arbab Hassan Rab Nawaz")
--   -> 68766dbe03051f14d95a8210 (hotel "Arbab Hassan Rab Nawaz") = 'arbab hassan rab nawaz'
--   verified 2026-09-07 on a shared phone
-- 6d1b7b15e277440cafcaf9a8e8983f8d (yango "ATIF SHABIR")
--   -> 67483c64055e070d791000fe (hotel "ATIF SHABIR MUHAMMAD SHABIR") = 'atif shabir muhammad shabir'
--   verified 2026-09-07 on a shared phone
-- ed0cc768ec3d46f4b8932dfbf24f12f3 (yango "BILAL AHMAD")
--   -> 67483c64055e070d79100106 (hotel "BILAL AHMAD HAJI REHMAN") = 'bilal ahmad haji rehman'
--   verified 2026-09-07 on a shared phone
-- 3c0d36fd2caf48fbb45a10e8cf9aab1d (yango "DANISH REHMAN")
--   -> 67483c64055e070d79100111 (hotel "DANISH REHMAN HAJI REHMAN") = 'danish rehman haji rehman'
--   verified 2026-09-07 on a shared phone
-- 449077790a0e4ac5a64585d4eb68eda1 (yango "DURGA PRASAD")
--   -> 67483c64055e070d791000cb (hotel "DURGA PRASAD BASYAL") = 'durga prasad basyal'
--   verified 2026-09-07 on a shared phone
-- 2948d032d7df4ad4827f611d296430c8 (yango "HAMZA KHAN")
--   -> 12293989-e71b-4ff1-9e99-85274479fab1 (uber "Hamza Khan Khan") = 'hamza khan'
--   verified 2026-09-07 on a shared phone
-- d22a7087f9ac42119cbe936749cd0bf1 (yango "Ifraz Ghulam Ahmed Ahmed")
--   -> 68766c6303051f14d95a81ed (hotel "Ifraz Ahmed Ghulam Ahmed") = 'ifraz ahmed ghulam ahmed'
--   verified 2026-09-07 on a shared phone
-- fa7219517bf24cefb719ec1b28e9a913 (yango "MAHAZ AHMAD")
--   -> f1bbe420-bd7f-43e0-b8d4-8ecd5e8f4719 (uber "Mahaz Ahmad Darwaish Khan") = 'mahaz ahmad darwaish khan'
--   verified 2026-09-07 on a shared phone
-- 735cc1574bfd46de8cfa7ed449d371f8 (yango "Matiullah Khan Sharif Khan")
--   -> 67483c64055e070d791000f7 (hotel "MATI ULLAH SHARIF KHAN") = 'mati ullah sharif khan'
--   verified 2026-09-07 on a shared phone
-- 9d77089bcf574517850372f447977d30 (yango "MIRZA ABDULLAH")
--   -> 67483c64055e070d7910010d (hotel "MIRZA ABDULLAH BAIG MIRZA ZAHID BAIG") = 'mirza abdullah baig mirza zahid baig'
--   verified 2026-09-07 on a shared phone
-- 4688f7772f494801902447e10c6df649 (yango "MOHAMMAD MOKDASSEL")
--   -> 67483c64055e070d79100125 (hotel "MOHAMMAD MOKDASSEL MD OBAIDULLAH") = 'mohammad mokdassel md obaidullah'
--   verified 2026-09-07 on a shared phone
-- ffe3cfced8554932a6faf50538e944bf (yango "MUHAMMAD MASOOD")
--   -> 67483c64055e070d791000d7 (hotel "MUHAMMAD MASOOD KISHBAR KHAN") = 'muhammad masood kishbar khan'
--   verified 2026-09-07 on a shared phone
-- e3cd308b2b5f48e19877b924b48bbb9d (yango "MUHAMMAD NADEEM")
--   -> 1936ced0-ccd5-4db0-b07f-ab084cee7bd9 (uber "Muhammad Nadeem Ajmal") = 'muhammad nadeem ajmal'
--   verified 2026-09-07 on a shared phone
-- 97d930a906e74d5d8d6fc25d75c2a128 (yango "MUHAMMAD RAHIM")
--   -> 67483c64055e070d79100103 (hotel "MUHAMMAD RAHIM MUHAMMAD SALEEM") = 'muhammad rahim muhammad saleem'
--   verified 2026-09-07 on a shared phone
-- 983dc9bfe04d4bd48729325ddaa42c0d (yango "Muhammad Shafiq")
--   -> 011fdd5b-54af-453e-aa17-b6f86c5fe11f (uber "Muhammad Shafiq Raziq") = 'muhammad shafiq raziq'
--   verified 2026-09-07 on a shared phone
-- 6589d771-fe78-4c9a-bc9d-686c39a91e4c (uber "Muhammad Zeeshan Shahid")
--   -> 4d57e153e6ff455782e4954a7862099a (yango "Muhammad Zeeshan Muhammad Shahid") = 'muhammad zeeshan muhammad shahid'
--   verified 2026-09-07 on a shared phone
-- cfad6f03a439432e8fa6f9c8fe89edcb (yango "Raja Khalil Ahmed Raja Nouman Khalil")
--   -> 37723dc3-b5f7-49ce-9c80-495bf5a2b49b (uber "Raja Nouman Ahmed") = 'raja nouman ahmed'
--   verified 2026-09-07 on a shared phone
-- 3629dde64f684e2abdcc0aeb1487632a (yango "RAKIBUL ALAM RAIHAN")
--   -> 67483c64055e070d791000cc (hotel "RAKIBUL ALAM RAIHAN MD SHOFIQUL ALAM") = 'rakibul alam raihan md shofiqul alam'
--   verified 2026-09-07 on a shared phone
-- ebe0dcf0-c554-4320-9f36-e61c17713d8d (uber "Rashid Ali Hussain")
--   -> 43183d548e3e487b9a5227705ace4719 (yango "Rashid Ali Haji Hussain") = 'rashid ali haji hussain'
--   verified 2026-09-07 on a shared phone
-- 67352587e6664d86b723b25eb7dbd89e (yango "RIZWAN ULLAH")
--   -> 67483c64055e070d79100118 (hotel "Rizwan Ullah Muzamil Khan") = 'rizwan ullah muzamil khan'
--   verified 2026-09-07 on a shared phone
-- ba329c7a6ac34245acf074c3250bc555 (yango "ROY VELLESPEN")
--   -> 3d3e3fa2-2e8c-43a9-8bf0-6b12dc3e26fe (uber "Roy Vellespen Ocdol") = 'roy vellespen ocdol'
--   verified 2026-09-07 on a shared phone
-- 13f61bb13eae43c3b0cf5d4af1c736d8 (yango "Sajid Ayaz")
--   -> 67483c64055e070d79100113 (hotel "SAJID AYAZ AYAZ AHMED") = 'sajid ayaz ahmed'
--   verified 2026-09-07 on a shared phone
-- 36b941b820be498c907628b253adb32b (yango "SAMEH TALAAT")
--   -> 67483c64055e070d7910010f (hotel "SAMEH TALAAT ABDELMAKSOUD ABDELSAMIE") = 'sameh talaat abdelmaksoud abdelsamie'
--   verified 2026-09-07 on a shared phone
-- f7d8a0ff324641b1bc96c649290da826 (yango "Sikandar Tariq")
--   -> 39042c26-8985-4f99-af1c-a990a63834e6 (uber "Sikandar Tariq Hussain") = 'sikandar tariq hussain'
--   verified 2026-09-07 on a shared phone
-- cf3a1777da6f49bb814d7cd3ec8f92fd (yango "SUMON AHMED")
--   -> 67483c64055e070d791000c8 (hotel "SUMON AHMED KHAN NIZAM UDDIN KHAN") = 'sumon ahmed khan nizam uddin khan'
--   verified 2026-09-07 on a shared phone
-- cac5cfedf0df4f90a0086cefc297d535 (yango "UMAR KAYANI")
--   -> 67483c64055e070d791000da (hotel "UMAR KAYANI NASIR WAHEED KAYANI") = 'umar kayani nasir waheed kayani'
--   verified 2026-09-07 on a shared phone
-- 563467d09d3d4f629b8b65e9c67d591f (yango "Umer Naveed")
--   -> 67483c64055e070d791000db (hotel "UMER NAVEED ABDUL QADIR") = 'umer naveed abdul qadir'
--   verified 2026-09-07 on a shared phone
-- 5d42345bcf4440df93645a54aedb9bc6 (yango "WAJID AKBAR")
--   -> 00dc098e-2f65-4b6b-9fbd-47305cdb18e0 (uber "Wajid Akbar Khan") = 'wajid akbar khan'
--   verified 2026-09-07 on a shared phone
-- b14f2b04795c411b8c01b2edc2a37774 (yango "ZAIN ALI GHULAM")
--   -> 67483c64055e070d79100120 (hotel "ZAIN ALI GHULAM HASSNAIN") = 'zain ali ghulam hassnain'
--   verified 2026-09-07 on a shared phone
-- 67483c64055e070d791000f5 (hotel "WISAL MUHAMMAD IRSHAD MUHAMMAD")
--   -> 64686123-8389-4a9e-82f1-0287e936239b (uber "Wisal Muhammad Muhammad") = 'wisal muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 122e8a0195354a0090474be38680ca2c (yango "wisal muhammad")
--   -> 64686123-8389-4a9e-82f1-0287e936239b (uber "Wisal Muhammad Muhammad") = 'wisal muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628822 (bolt "Muhammad Khalifa Afzal Khalid")
--   -> 67483c64055e070d79100112 (hotel "MUHAMMAD KHALIFA AFZAL KHALID") = 'muhammad khalifa afzal khalid'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-13, 2025-11-17, 2025-12-07, 2025-12-26
-- dc2705246ec84c17921d272b0aaf73d3 (yango "MUHAMMAD KHALIFA")
--   -> 67483c64055e070d79100112 (hotel "MUHAMMAD KHALIFA AFZAL KHALID") = 'muhammad khalifa afzal khalid'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-13, 2025-11-17, 2025-12-07, 2025-12-26
-- 6842136 (bolt "Zeeshan Ahmed Wazeer Ur Rahman")
--   -> 76aa7207-cd18-4498-a9b6-e11d8b45e266 (uber "Zeeshan Ahmad Ur Rahman") = 'zeeshan ahmad ur rahman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-06-07
-- 4517ca6e-8b79-4bd4-8e4d-88c86d5dd6b9 (bolt "Zeeshan Ahmed Wazeer Ur Rahman")
--   -> 76aa7207-cd18-4498-a9b6-e11d8b45e266 (uber "Zeeshan Ahmad Ur Rahman") = 'zeeshan ahmad ur rahman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-06-07
-- 6615331 (bolt "Muhammad Talha Faizullah")
--   -> 9efd4d0b-2db7-4f57-88e8-8450e2803f8f (uber "Muhammad Talha Faizullah") = 'muhammad talha faizullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 467b94c54718457da9f3d434d3a5390c (yango "Muhammad Talha Faizullah")
--   -> 9efd4d0b-2db7-4f57-88e8-8450e2803f8f (uber "Muhammad Talha Faizullah") = 'muhammad talha faizullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d79100126 (hotel "MUHAMMAD TALHA FAIZULLAH")
--   -> 9efd4d0b-2db7-4f57-88e8-8450e2803f8f (uber "Muhammad Talha Faizullah") = 'muhammad talha faizullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6639159 (bolt "Fawad Ali Khan Ayaz Muhammad")
--   -> 67483c64055e070d791000d0 (hotel "FAWAD ALI KHAN AYAZ MUHAMMAD") = 'fawad ali khan ayaz muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- b4a7efd8-2808-4058-8595-635918c6bcf2 (uber "Umer Naveed Qadir")
--   -> 67483c64055e070d791000db (hotel "UMER NAVEED ABDUL QADIR") = 'umer naveed abdul qadir'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611555 (bolt "Umer Naveed Abdul Qadir")
--   -> 67483c64055e070d791000db (hotel "UMER NAVEED ABDUL QADIR") = 'umer naveed abdul qadir'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 680790c003051f14d956b356 (hotel "Ali Abbas Faiz Ahmed")
--   -> 9e9060e7-0b8c-4f3b-8cd7-165d5eac55cd (uber "Ali Abbas Ahmed") = 'ali abbas ahmed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6640364 (bolt "Muhammad Asif Amir Zada")
--   -> 6ee7b8e2-c47d-46be-ac7b-d0c74c36391c (uber "Muhammad Asif Zada") = 'muhammad asif zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9407cd209754464885335d800596c5ae (yango "Muhammad Asif Amir Zada")
--   -> 6ee7b8e2-c47d-46be-ac7b-d0c74c36391c (uber "Muhammad Asif Zada") = 'muhammad asif zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d7910010b (hotel "MUHAMMAD ASIF AMIR ZADA")
--   -> 6ee7b8e2-c47d-46be-ac7b-d0c74c36391c (uber "Muhammad Asif Zada") = 'muhammad asif zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6616065 (bolt "Mahaz Ahmad Darwaish Khan")
--   -> f1bbe420-bd7f-43e0-b8d4-8ecd5e8f4719 (uber "Mahaz Ahmad Darwaish Khan") = 'mahaz ahmad darwaish khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000e1 (hotel "MAHAZ AHMAD DARWAISH KHAN")
--   -> f1bbe420-bd7f-43e0-b8d4-8ecd5e8f4719 (uber "Mahaz Ahmad Darwaish Khan") = 'mahaz ahmad darwaish khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6901260 (bolt "Wajid Ali Ameer Bakhsh")
--   -> 0a59fd2f-6fcc-497f-b274-4462bbc3ddf3 (uber "Wajid Ali Ameer Bakhsh") = 'wajid ali ameer bakhsh'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- ffe30d6937114c1282457ed38010d274 (yango "Wajid Ali")
--   -> 0a59fd2f-6fcc-497f-b274-4462bbc3ddf3 (uber "Wajid Ali Ameer Bakhsh") = 'wajid ali ameer bakhsh'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000dc (hotel "WAJID ALI AMEER BAKHSH")
--   -> 0a59fd2f-6fcc-497f-b274-4462bbc3ddf3 (uber "Wajid Ali Ameer Bakhsh") = 'wajid ali ameer bakhsh'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628151 (bolt "Aamir Khan Roohul Amin")
--   -> efa5df29-c8ac-47d7-9ce2-be046f5d3a0f (uber "Aamir Khan Amin") = 'aamir khan amin'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-09-22, 2025-09-23, 2025-09-28, 2025-10-03, 2025-10-08, 2025-10-11, 2025-10-14
-- 67483c64055e070d7910011e (hotel "AAMIR KHAN ROOHUL AMIN AMIN")
--   -> efa5df29-c8ac-47d7-9ce2-be046f5d3a0f (uber "Aamir Khan Amin") = 'aamir khan amin'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-09-22, 2025-09-23, 2025-09-28, 2025-10-03, 2025-10-08, 2025-10-11, 2025-10-14
-- 005211c6d1204ab89ffe0ed358cfa91a (yango "Sabeel Khan Najeeb Ullah Khan")
--   -> 00b3e873-1399-4db2-a781-1eb432fd8b9f (uber "Najeeb Ullah Khan Khan") = 'najeeb ullah khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 69b7cb84cc90e854f1e4ff16 (hotel "Najeeb ullah khan")
--   -> 00b3e873-1399-4db2-a781-1eb432fd8b9f (uber "Najeeb Ullah Khan Khan") = 'najeeb ullah khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6640532 (bolt "Zia Ali Said Muhammad")
--   -> 67483c64055e070d7910012d (hotel "ZIA ALI SAID MUHAMMAD") = 'zia ali said muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611346 (bolt "Abdul Basit Ayaz Ahmed")
--   -> 89886d77-952a-4df7-b206-8ada3b9afc78 (uber "Abdul Basit Ayaz Ahmed") = 'abdul basit ayaz ahmed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 02cec98f-25ae-4cb9-9fd5-671920f958ac (bolt "Abdul Basit Ayaz Ahmed")
--   -> 89886d77-952a-4df7-b206-8ada3b9afc78 (uber "Abdul Basit Ayaz Ahmed") = 'abdul basit ayaz ahmed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7779693 (bolt "Siyad Kallyanathoppil Paramba Razak Kallyanathoppil")
--   -> 12ce7e65-2ce7-4629-b958-17bb7a4e7bb8 (uber "Siyad Kallyanathoppil Paramba") = 'siyad kallyanathoppil paramba'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-02, 2025-11-06
-- 6d175dd8-8d9c-4c88-8399-5b5c8a5efb85 (bolt "Siyad Kallyanathoppil Paramba Razak Kallyanathoppil")
--   -> 12ce7e65-2ce7-4629-b958-17bb7a4e7bb8 (uber "Siyad Kallyanathoppil Paramba") = 'siyad kallyanathoppil paramba'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-02, 2025-11-06
-- 90f893d3-7595-4743-8efe-62b2815677b7 (uber "Ansar Hussain Khalid")
--   -> 5e3b947b-b927-47be-9845-24d6842acf0e (uber "Hussain Ansar") = 'hussain ansar'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7624035 (bolt "Ansar Hussain Khalid")
--   -> 5e3b947b-b927-47be-9845-24d6842acf0e (uber "Hussain Ansar") = 'hussain ansar'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 58de23fbd6e14a4389b7557c732ee607 (yango "Khalid Ansar Hussain")
--   -> 5e3b947b-b927-47be-9845-24d6842acf0e (uber "Hussain Ansar") = 'hussain ansar'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628504 (bolt "Mohammed A A Alsoos")
--   -> 67483c64055e070d7910012f (hotel "MOHAMMED A A ALSOOS") = 'mohammed alsoos'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2026-09-16
-- 518aacd8fd9347bca83baef90671cb77 (yango "MOHAMMED A A ALSOUS")
--   -> 67483c64055e070d7910012f (hotel "MOHAMMED A A ALSOOS") = 'mohammed alsoos'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2026-09-16
-- 6598737 (bolt "Abass Tanko")
--   -> dbbeb72d-716a-4327-8705-f08dae83a240 (uber "Abass Tanko") = 'abass tanko'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 41a6094035854fa49079fd38fff276ec (yango "ABASS TANKO")
--   -> dbbeb72d-716a-4327-8705-f08dae83a240 (uber "Abass Tanko") = 'abass tanko'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d7910011c (hotel "ABASS TANKO")
--   -> dbbeb72d-716a-4327-8705-f08dae83a240 (uber "Abass Tanko") = 'abass tanko'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- fb09dfee-cf6d-4391-8b57-e45e0e9ec743 (uber "Zain Ali Hassnain")
--   -> 67483c64055e070d79100120 (hotel "ZAIN ALI GHULAM HASSNAIN") = 'zain ali ghulam hassnain'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-11-09, 2025-11-10, 2025-11-11, 2025-11-15
-- 6633916 (bolt "Zain Ali Ghulam Hassnain")
--   -> 67483c64055e070d79100120 (hotel "ZAIN ALI GHULAM HASSNAIN") = 'zain ali ghulam hassnain'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-11-09, 2025-11-10, 2025-11-11, 2025-11-15
-- 6611368 (bolt "Asif Mehmood Abdul Qadeer")
--   -> e1fb2ce2-8ab3-4897-aa6d-209b91df2fff (uber "Asif Mehmood Abdul Qadeer") = 'asif mehmood abdul qadeer'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- d7cf380a-7777-431f-ac84-78afe493988d (bolt "Asif Mehmood Abdul Qadeer")
--   -> e1fb2ce2-8ab3-4897-aa6d-209b91df2fff (uber "Asif Mehmood Abdul Qadeer") = 'asif mehmood abdul qadeer'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7399815 (bolt "Abu Bakar Siddique Kamil Shah")
--   -> 5779be46aefa4bacaa413aa861219444 (yango "Abu Bakar Saddique Kamil Shah") = 'abu bakar saddique kamil shah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7644369 (bolt "Sajid Gul Gul Muhammad")
--   -> 68905711d0a931b9d754492a (hotel "Sajid Gul Gul Muhammad") = 'sajid gul muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 072492179a9c45e9b2aa438122615687 (yango "Gul Muhammad Sajid Gul")
--   -> 68905711d0a931b9d754492a (hotel "Sajid Gul Gul Muhammad") = 'sajid gul muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7208744 (bolt "Abidullah Safi")
--   -> dae09063-88a3-432e-b39f-969d8de7992b (uber "Abidullah Safi") = 'abidullah safi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 60e3d6c96fd44a5599ba7d326db30f47 (yango "Abidullah Safi")
--   -> dae09063-88a3-432e-b39f-969d8de7992b (uber "Abidullah Safi") = 'abidullah safi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 691d9b128c482942eaad6aa7 (hotel "Muhammad Touseef Shakeel Muhammad Bangash")
--   -> 81cf7546-94b0-43ab-8952-cc3fbb7b88f2 (uber "Muhammad Toussef Bangash") = 'muhammad toussef bangash'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628167 (bolt "Roy Vellespen Ocdol")
--   -> 3d3e3fa2-2e8c-43a9-8bf0-6b12dc3e26fe (uber "Roy Vellespen Ocdol") = 'roy vellespen ocdol'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d79100100 (hotel "ROY VELLESPEN OCDOL")
--   -> 3d3e3fa2-2e8c-43a9-8bf0-6b12dc3e26fe (uber "Roy Vellespen Ocdol") = 'roy vellespen ocdol'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611263 (bolt "Mohd Shohidul Islam Shamsul Alam")
--   -> 45be24f8-e15a-4a94-897a-23f52daa16a8 (uber "Mohd Shohidul Islam Shamsul Alam") = 'mohd shohidul islam shamsul alam'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- c366fc8a-a007-461a-b06d-256d9c411c85 (bolt "Mohd Shohidul Islam Shamsul Alam")
--   -> 45be24f8-e15a-4a94-897a-23f52daa16a8 (uber "Mohd Shohidul Islam Shamsul Alam") = 'mohd shohidul islam shamsul alam'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 4f54b70d5fd54aad8554f8c33ed20d8b (yango "Hammad Ahmad Aftab Ahmad")
--   -> d454e6b8-6d69-469e-91a5-37c174dac8fd (uber "Hammad Ahmad Ahmad") = 'hammad ahmad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2026-07-08
-- 6610879 (bolt "Mummer Inam Inam Ullah")
--   -> 1220e297-7538-4e00-be3d-5275afe760d5 (uber "Mummer Inam Inam Ullah") = 'mummer inam ullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 4a315dee-2a2d-45b2-b2a1-cda45828ed6e (bolt "Mummer Inam Inam Ullah")
--   -> 1220e297-7538-4e00-be3d-5275afe760d5 (uber "Mummer Inam Inam Ullah") = 'mummer inam ullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- c74f4bf5fe2f45bfbd3c42a68857f3f0 (yango "ZAHID KHAN")
--   -> c33cc3d6-77d2-4e13-a916-f08a89daf2bb (uber "Zahid Khan Khan") = 'zahid khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 3343a680ce234548998464bfd7784cb3 (yango "Zahid Khan Mohabbat Khan")
--   -> c33cc3d6-77d2-4e13-a916-f08a89daf2bb (uber "Zahid Khan Khan") = 'zahid khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611186 (bolt "Mohammed Fazlul Karim Imran Abu Bakar Siddik")
--   -> 70f25511-3dd2-486a-927f-e19d5c2482ca (uber "Mohammed Fazlul Siddik") = 'mohammed fazlul siddik'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 0876b449-12ca-45dd-8f44-262b901a4772 (bolt "Mohammed Fazlul Karim Imran Abu Bakar Siddik")
--   -> 70f25511-3dd2-486a-927f-e19d5c2482ca (uber "Mohammed Fazlul Siddik") = 'mohammed fazlul siddik'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6818383 (bolt "Mohamed Essam Abdelrazek Khalil Abdelfattah")
--   -> e3796787-f3f9-41f9-a299-2e5862cbbf76 (uber "Mohamed Essam Abdelfattah") = 'mohamed essam abdelfattah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 208a7776-fc88-4604-ab49-631437b77dd5 (bolt "Mohamed Essam Abdelrazek Khalil Abdelfattah")
--   -> e3796787-f3f9-41f9-a299-2e5862cbbf76 (uber "Mohamed Essam Abdelfattah") = 'mohamed essam abdelfattah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 33cce538-9975-4d96-b770-df1178d2ad5c (uber "Mati Ulah Khan")
--   -> 67483c64055e070d791000f7 (hotel "MATI ULLAH SHARIF KHAN") = 'mati ullah sharif khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6781253 (bolt "Mati Ullah Sharif Khan")
--   -> 67483c64055e070d791000f7 (hotel "MATI ULLAH SHARIF KHAN") = 'mati ullah sharif khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7841834 (bolt "Wahab Ali Sahib Zada")
--   -> 261a9688-e59e-4b73-bf1a-3bbb2f52a271 (uber "Wahab Ali Zada") = 'wahab ali zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6a4f4253b3b4e99c0391a15e (hotel "WAHAB ALI SAHIB ZADA")
--   -> 261a9688-e59e-4b73-bf1a-3bbb2f52a271 (uber "Wahab Ali Zada") = 'wahab ali zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 72191eb6-9500-4974-a4cc-b8211333e809 (bolt "Wahab Ali Sahib Zada")
--   -> 261a9688-e59e-4b73-bf1a-3bbb2f52a271 (uber "Wahab Ali Zada") = 'wahab ali zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628149 (bolt "Harish Kumar Karam Chand")
--   -> f6a10bac-7ea4-4b9a-b37a-a817aad5d7f9 (uber "Harish Kumar Chand") = 'harish kumar chand'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 688a1c98a0bf23d354fda5a7 (hotel "Harish Kumar Karam Chand")
--   -> f6a10bac-7ea4-4b9a-b37a-a817aad5d7f9 (uber "Harish Kumar Chand") = 'harish kumar chand'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6623707 (bolt "Ali Nawaz Muhammad Nawaz")
--   -> 67483c64055e070d791000f0 (hotel "ALI NAWAZ MUHAMMAD NAWAZ") = 'ali nawaz muhammad nawaz'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-18
-- 10e01fb59b184ab88dc750704a9bc10e (yango "ALI NAWAZ")
--   -> 67483c64055e070d791000f0 (hotel "ALI NAWAZ MUHAMMAD NAWAZ") = 'ali nawaz muhammad nawaz'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-18
-- 7838158 (bolt "Hamza Iqbal Sajid Iqbal")
--   -> a48e26a8-8c0a-41c5-bef8-72802cf1398f (uber "Hamza Iqbal Sajid Iqbal") = 'hamza iqbal sajid iqbal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 68b94a08b0dc20d631c56a68 (hotel "Hamza Iqbal Sajid Iqbal")
--   -> a48e26a8-8c0a-41c5-bef8-72802cf1398f (uber "Hamza Iqbal Sajid Iqbal") = 'hamza iqbal sajid iqbal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 48cfb2ac-0ddc-4742-96ed-6b1d2a09c491 (bolt "Hamza Iqbal Sajid Iqbal")
--   -> a48e26a8-8c0a-41c5-bef8-72802cf1398f (uber "Hamza Iqbal Sajid Iqbal") = 'hamza iqbal sajid iqbal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6ac3a5d36e0dbece4b47dd5d (hotel "Muhammad Nazir Zarin Khan")
--   -> cc12b6f3-7ce0-4dae-afcd-4454dd36a401 (uber "Muhammad Nazir Khan") = 'muhammad nazir khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6620288 (bolt "Muhammad Sameer Shamrez Asghar")
--   -> 67483c64055e070d79100131 (hotel "MUHAMMAD SAMEER SHAMREZ ASGHAR") = 'muhammad sameer shamrez asghar'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9b9d8a53b6ea47f5a5b0e5e4ddca9d1f (yango "muhammad sameer")
--   -> 67483c64055e070d79100131 (hotel "MUHAMMAD SAMEER SHAMREZ ASGHAR") = 'muhammad sameer shamrez asghar'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6997345 (bolt "Muhammad Shahab Abbasi Muhammad Shahzad Abbasi")
--   -> 4e47dd44-842d-48bc-ae66-de5d08c3424d (uber "Muhammad Shahab Abbasi") = 'muhammad shahab abbasi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 02578759-f32e-41c7-a096-51ebe1c046aa (bolt "Muhammad Shahab Abbasi Muhammad Shahzad Abbasi")
--   -> 4e47dd44-842d-48bc-ae66-de5d08c3424d (uber "Muhammad Shahab Abbasi") = 'muhammad shahab abbasi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000ff (hotel "Muhammad Shahab Abbasi Shahzad Abbasi")
--   -> 4e47dd44-842d-48bc-ae66-de5d08c3424d (uber "Muhammad Shahab Abbasi") = 'muhammad shahab abbasi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7501194 (bolt "Ullah Abdul Rasheed Moosa Moosa Ullal Kotepura")
--   -> 72d2f062-70d0-404a-8b52-00b4534446a2 (uber "Ullal Abdul Rasheed Kotepura") = 'ullal abdul rasheed kotepura'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 68821890a0bf23d354fd700d (hotel "Ullal Abdul Rasheed Moosa Moosa Ullal Kotepura")
--   -> 72d2f062-70d0-404a-8b52-00b4534446a2 (uber "Ullal Abdul Rasheed Kotepura") = 'ullal abdul rasheed kotepura'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 1fc71474-5345-46e9-b7d9-3f5a38bbdbf0 (bolt "Ullah Abdul Rasheed Moosa Moosa Ullal Kotepura")
--   -> 72d2f062-70d0-404a-8b52-00b4534446a2 (uber "Ullal Abdul Rasheed Kotepura") = 'ullal abdul rasheed kotepura'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6620158 (bolt "Kashif Ali Ayyub Khan")
--   -> 84d498cf-a74a-4750-9ac2-5eabdeec3b8d (uber "Kashif Ali Ayyub khan") = 'kashif ali ayyub khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- a411e6c0e37c42f4869f4b230fc78292 (yango "Kashif Ali")
--   -> 84d498cf-a74a-4750-9ac2-5eabdeec3b8d (uber "Kashif Ali Ayyub khan") = 'kashif ali ayyub khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6d707fcd-fe3d-43f3-b0b9-778c798cacd0 (uber "Arbab Hassan Nawaz")
--   -> 68766dbe03051f14d95a8210 (hotel "Arbab Hassan Rab Nawaz") = 'arbab hassan rab nawaz'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7605526 (bolt "Arbab Hassan Rab Nawaz")
--   -> 68766dbe03051f14d95a8210 (hotel "Arbab Hassan Rab Nawaz") = 'arbab hassan rab nawaz'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6623598 (bolt "Faisal Badshah Rasool Badshah")
--   -> 67483c64055e070d79100109 (hotel "FAISAL BADSHAH RASOOL BADSHAH") = 'faisal badshah rasool badshah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2026-04-21, 2026-05-01
-- d43113c2f35f4d7ea618c70845c85247 (yango "BADSHAH FAISAL")
--   -> 67483c64055e070d79100109 (hotel "FAISAL BADSHAH RASOOL BADSHAH") = 'faisal badshah rasool badshah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2026-04-21, 2026-05-01
-- 7727920 (bolt "Waqas Riaz Muhammad Riaz")
--   -> f9ac5f80-275c-4320-b9c5-0535e69dfceb (uber "Waqas Riaz Riaz") = 'waqas riaz'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- a604d59c88e94a758ce9a19264fec2dc (yango "Muhammad Riaz Waqas Riaz")
--   -> f9ac5f80-275c-4320-b9c5-0535e69dfceb (uber "Waqas Riaz Riaz") = 'waqas riaz'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7726833 (bolt "Aftab Ahmed Muhammad Sharif Altaf")
--   -> 68905c41d0a931b9d7544982 (hotel "Aftab Ahmed Muhammad Sharif Altaf") = 'aftab ahmed muhammad sharif altaf'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8181338 (bolt "Farman Ullah Ghafoor Khan")
--   -> de9a4044-c57e-427c-ae06-5bca66873857 (uber "Farman Ullah Ghafoor Khan") = 'farman ullah ghafoor khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- f6c68bff-3b30-436b-9481-ee0fa4da9958 (bolt "Renato Romillano Yap")
--   -> 92a7bd85-e275-4582-b792-b1922a2bf9b5 (uber "Renato Romillano Yap") = 'renato romillano yap'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7976866 (bolt "Joseph Wandera")
--   -> 1e2311ad-cc26-4e2b-839a-41363ef67672 (uber "Joseph Wandera") = 'joseph wandera'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611279 (bolt "Ahmed Mohamed Ramadan Ahmed Gadalla")
--   -> 54c5a53d-ca40-4206-8a04-1f63d828e1c1 (uber "Ahmed Mohamed Gadalla") = 'ahmed mohamed gadalla'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 60003270-6e09-495b-b801-bbf4c6b7aa53 (bolt "Ahmed Mohamed Ramadan Ahmed Gadalla")
--   -> 54c5a53d-ca40-4206-8a04-1f63d828e1c1 (uber "Ahmed Mohamed Gadalla") = 'ahmed mohamed gadalla'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8219954 (bolt "Alakbar Rahimov")
--   -> cf08a7df-1a9f-450c-92aa-baa8d9da5f7b (uber "ALAKBAR RAHIMOV") = 'alakbar rahimov'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7b1408ba9a154514b1d2c6182eaf2d75 (yango "Alakbar Rahimov")
--   -> cf08a7df-1a9f-450c-92aa-baa8d9da5f7b (uber "ALAKBAR RAHIMOV") = 'alakbar rahimov'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8175513 (bolt "Muhammad Yaseen Saeed Ur Rahman")
--   -> 5ebc7cba-8f77-487e-aba9-ae5ff0111ed1 (uber "Muhammad Yaseen Saeed Ur Rahman") = 'muhammad yaseen saeed ur rahman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8185992 (bolt "Waseem Abbas Ghulam Nabi")
--   -> 6911c82f8c482942eaacf939 (hotel "Waseem Abbas Ghulam Nabi") = 'waseem abbas ghulam nabi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 82b0abaeab4c4ee3b95fa8094978ca9a (yango "Waseem Abbas Ghulam Nabi")
--   -> 6911c82f8c482942eaacf939 (hotel "Waseem Abbas Ghulam Nabi") = 'waseem abbas ghulam nabi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6640352 (bolt "Umair Ahmad")
--   -> 7ff1e0bb-8c80-4948-9cd8-86902625ac40 (uber "Umair Ahmad Gul") = 'umair ahmad gul'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000eb (hotel "UMAIR AHMAD WAZIR GUL")
--   -> 7ff1e0bb-8c80-4948-9cd8-86902625ac40 (uber "Umair Ahmad Gul") = 'umair ahmad gul'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- b3edf09c58f542e98ff5bd1068d178e8 (yango "UMAIR AHMAD")
--   -> 7ff1e0bb-8c80-4948-9cd8-86902625ac40 (uber "Umair Ahmad Gul") = 'umair ahmad gul'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8074837 (bolt "Sikandar Tariq Tariq Hussain")
--   -> 39042c26-8985-4f99-af1c-a990a63834e6 (uber "Sikandar Tariq Hussain") = 'sikandar tariq hussain'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7624077 (bolt "Rashid Khan Zar Muhammad")
--   -> 793529a4-6264-497f-9dc5-e7f4e62cbc8a (uber "Rashid Khan Muhammad") = 'rashid khan muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6a37fe4f-8f44-4af0-a043-5cc3e1ffdcb1 (uber "Mohammad Mokdassel Obaidullah")
--   -> 67483c64055e070d79100125 (hotel "MOHAMMAD MOKDASSEL MD OBAIDULLAH") = 'mohammad mokdassel md obaidullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628253 (bolt "MOHAMMAD MOKDASSEL MD OBAIDULLAH")
--   -> 67483c64055e070d79100125 (hotel "MOHAMMAD MOKDASSEL MD OBAIDULLAH") = 'mohammad mokdassel md obaidullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628607 (bolt "Abdul Malik Muhammad Iqbal")
--   -> 975db95e-0c42-4909-8597-53ffe66fadaf (uber "Abdul Malik Muhammad Iqbal") = 'abdul malik muhammad iqbal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-05-19
-- 67483c64055e070d791000d6 (hotel "ABDUL MALIK MUHAMMAD IQBAL")
--   -> 975db95e-0c42-4909-8597-53ffe66fadaf (uber "Abdul Malik Muhammad Iqbal") = 'abdul malik muhammad iqbal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-05-19
-- 7003039 (bolt "Henok Melese Amdisa")
--   -> 2e9e87f5-7b0e-4ccd-af22-64d6bec268f4 (uber "Henok Melese Amdisa") = 'henok melese amdisa'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8b20b014-d999-41cf-965f-c10363175d5e (bolt "Henok Melese Amdisa")
--   -> 2e9e87f5-7b0e-4ccd-af22-64d6bec268f4 (uber "Henok Melese Amdisa") = 'henok melese amdisa'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7643624 (bolt "Muhammad Hanan Munir Muhammad Munir")
--   -> 688085f5a0bf23d354fd60b0 (hotel "Muhammad Hanan Munir Muhammad Munir") = 'muhammad hanan munir muhammad munir'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- bdc98198249e4b6698131d2b5667bcd7 (yango "Muhammad Hanan")
--   -> 688085f5a0bf23d354fd60b0 (hotel "Muhammad Hanan Munir Muhammad Munir") = 'muhammad hanan munir muhammad munir'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6623922 (bolt "MUHAMMAD SHAFIQ")
--   -> 011fdd5b-54af-453e-aa17-b6f86c5fe11f (uber "Muhammad Shafiq Raziq") = 'muhammad shafiq raziq'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000e9 (hotel "MUHAMMAD SHAFIQ UMAR RAZIQ")
--   -> 011fdd5b-54af-453e-aa17-b6f86c5fe11f (uber "Muhammad Shafiq Raziq") = 'muhammad shafiq raziq'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6a8dac427ba7dbf44436ca89 (hotel "Bashir Ahmed Muhammad Amin")
--   -> 369dd9c1-ae0a-4526-8d46-d91a8c217121 (uber "Bashir Ahmad Amin") = 'bashir ahmad amin'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7238992 (bolt "Dawit Zeraye Haile")
--   -> 4880dbcc-f2dd-45ed-a2b9-900bb61bc93b (uber "Dawit Zeraye Haile") = 'dawit zeraye haile'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- d10ed574-6f79-4f07-990a-5ec7f91a2df4 (bolt "Dawit Zeraye Haile")
--   -> 4880dbcc-f2dd-45ed-a2b9-900bb61bc93b (uber "Dawit Zeraye Haile") = 'dawit zeraye haile'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- bb4b1157-37e9-443c-82ef-1fb33660e9ad (uber "Ifraz Ahmed Ahmed")
--   -> 68766c6303051f14d95a81ed (hotel "Ifraz Ahmed Ghulam Ahmed") = 'ifraz ahmed ghulam ahmed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7523359 (bolt "Ifraz Ahmed Ghulam Ahmed")
--   -> 68766c6303051f14d95a81ed (hotel "Ifraz Ahmed Ghulam Ahmed") = 'ifraz ahmed ghulam ahmed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8120259 (bolt "Henry Martin Motha Henry Bennet Motha")
--   -> 550133d0-affd-45b4-9082-0a95a39bd09f (uber "Henry Martin Motha") = 'henry martin motha'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6904614c8c482942eaac6e48 (hotel "Henry Martin Motha Henry Bennet Motha")
--   -> 550133d0-affd-45b4-9082-0a95a39bd09f (uber "Henry Martin Motha") = 'henry martin motha'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 48a7ee6e-f6d7-4491-a811-798263d4616f (bolt "Henry Martin Motha Henry Bennet Motha")
--   -> 550133d0-affd-45b4-9082-0a95a39bd09f (uber "Henry Martin Motha") = 'henry martin motha'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8636581 (bolt "Muhammad Naqeeb Nasir Gull")
--   -> b629aefa-7fc1-4bbe-84db-25920914105d (uber "Muhammad Naqeeb Gull") = 'muhammad naqeeb gull'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67731662-84af-4378-a00d-664845eaee9a (bolt "Muhammad Naqeeb Nasir Gull")
--   -> b629aefa-7fc1-4bbe-84db-25920914105d (uber "Muhammad Naqeeb Gull") = 'muhammad naqeeb gull'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7874177 (bolt "Muhammad Naeem Khan Amir Muhammad Khan")
--   -> 1ffc17512bae40d2a6899f35aad12789 (yango "Amir Muhammad Khan Muhammad Naeem Khan") = 'amir muhammad khan muhammad naeem khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628730 (bolt "Mateen Gul")
--   -> 31ec8c94-1f92-4fe8-bcd3-8bf83ae928be (uber "Mateen Gul Gul") = 'mateen gul'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 352cdd896af14ffca96d2fb943c99ad0 (yango "MATEEN GUL")
--   -> 31ec8c94-1f92-4fe8-bcd3-8bf83ae928be (uber "Mateen Gul Gul") = 'mateen gul'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- fd30bb7f-8964-4195-8e94-125ae117772f (uber "Sajid Ayaz Ahmed")
--   -> 67483c64055e070d79100113 (hotel "SAJID AYAZ AYAZ AHMED") = 'sajid ayaz ahmed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6610666 (bolt "Sajid Ayaz Ayaz Ahmed")
--   -> 67483c64055e070d79100113 (hotel "SAJID AYAZ AYAZ AHMED") = 'sajid ayaz ahmed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628224 (bolt "Kashan Malik Abdul Malik")
--   -> 67483c64055e070d791000fc (hotel "KASHAN MALIK ABDUL MALIK") = 'kashan malik abdul malik'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- f4a294bd4b48456496921e542e58e79e (yango "KASHAN MALIK")
--   -> 67483c64055e070d791000fc (hotel "KASHAN MALIK ABDUL MALIK") = 'kashan malik abdul malik'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7976847 (bolt "Moses Bale")
--   -> 628fbdea-1404-4289-a5b5-9bab4dc69cf0 (uber "Moses Bale") = 'moses bale'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 16b7df80-d744-4dc4-87d2-7a7d588d849e (uber "Mirza Abdullah Baig")
--   -> 67483c64055e070d7910010d (hotel "MIRZA ABDULLAH BAIG MIRZA ZAHID BAIG") = 'mirza abdullah baig mirza zahid baig'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628129 (bolt "Mirza Abdullah baig Mirza Zahid baig")
--   -> 67483c64055e070d7910010d (hotel "MIRZA ABDULLAH BAIG MIRZA ZAHID BAIG") = 'mirza abdullah baig mirza zahid baig'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611073 (bolt "Zeeshan Nadeem Nadeem Akram")
--   -> 8189219b-6037-4114-9e80-4847e7cd842f (uber "Zeeshan Nadeem Nadeem Akram") = 'zeeshan nadeem akram'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-20, 2025-10-23
-- 67483c64055e070d79100132 (hotel "ZEESHAN NADEEM NADEEM AKRAM")
--   -> 8189219b-6037-4114-9e80-4847e7cd842f (uber "Zeeshan Nadeem Nadeem Akram") = 'zeeshan nadeem akram'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-20, 2025-10-23
-- 6e53bb51-d55e-4370-b855-10cb8025b936 (uber "Bilal Ahmad rehman")
--   -> 67483c64055e070d79100106 (hotel "BILAL AHMAD HAJI REHMAN") = 'bilal ahmad haji rehman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628147 (bolt "Bilal Ahmad Haji Rehman")
--   -> 67483c64055e070d79100106 (hotel "BILAL AHMAD HAJI REHMAN") = 'bilal ahmad haji rehman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7cf929d6-45fa-4b87-ac1f-4469ef103358 (uber "Muhammad Rahim Saleem")
--   -> 67483c64055e070d79100103 (hotel "MUHAMMAD RAHIM MUHAMMAD SALEEM") = 'muhammad rahim muhammad saleem'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628824 (bolt "Muhammad Rahim Muhammad Saleem")
--   -> 67483c64055e070d79100103 (hotel "MUHAMMAD RAHIM MUHAMMAD SALEEM") = 'muhammad rahim muhammad saleem'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 567a259c-9610-4fea-9704-7e9bfd8397ad (bolt "Andreh Elias Aoun")
--   -> eb7c8909-2a1b-418d-a920-49dced4913e0 (uber "Andreh Elias Aoun") = 'andreh elias aoun'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6939735 (bolt "Wajid Rehman Nausherwan")
--   -> ca15a7c6-5df0-4bdc-abec-918c78876c47 (uber "Wajid Rehman Nausherwan") = 'wajid rehman nausherwan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000fb (hotel "WAJID REHMAN NAUSHERWAN")
--   -> ca15a7c6-5df0-4bdc-abec-918c78876c47 (uber "Wajid Rehman Nausherwan") = 'wajid rehman nausherwan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9048361 (bolt "Chahat Ravinder")
--   -> 23a9d6f0-c916-477d-8624-91038a7d9fb8 (uber "Chahat Ravinder") = 'chahat ravinder'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- c9943fab-aca7-42c3-a7b6-bb91a298f1b3 (bolt "Chahat Ravinder")
--   -> 23a9d6f0-c916-477d-8624-91038a7d9fb8 (uber "Chahat Ravinder") = 'chahat ravinder'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8143925 (bolt "Hassan Talaat Kamel Abousira")
--   -> 293f7986-1768-4c56-8317-133ee31d89fb (uber "Hassan Talaat Kamel Abousira") = 'hassan talaat kamel abousira'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6634999 (bolt "MIDRAR KHAN MISRI KHAN")
--   -> 6f48f5a4-747f-4272-bbec-a413272103e5 (uber "Midrar Khan Khan") = 'midrar khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d7910011a (hotel "Midrar Khan Misri Khan")
--   -> 6f48f5a4-747f-4272-bbec-a413272103e5 (uber "Midrar Khan Khan") = 'midrar khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611356 (bolt "Hasan Wadie Alabaza")
--   -> 2c06cfc8-df51-4c32-af89-64fb16699a1b (uber "Hasan Wadie Alabaza") = 'hasan wadie alabaza'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- f9aa707b-6b85-460c-91c5-b88df7808758 (bolt "Hasan Wadie Alabaza")
--   -> 2c06cfc8-df51-4c32-af89-64fb16699a1b (uber "Hasan Wadie Alabaza") = 'hasan wadie alabaza'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6663860 (bolt "Zahid Ullah Afsar Zada")
--   -> faab28eb-79bf-4863-b430-1d0d2167bb05 (uber "Zahid Ullah Afsar Zada") = 'zahid ullah afsar zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d79100127 (hotel "ZAHID ULLAH AFSAR ZADA")
--   -> faab28eb-79bf-4863-b430-1d0d2167bb05 (uber "Zahid Ullah Afsar Zada") = 'zahid ullah afsar zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6a242abc-ea2e-4a67-8d70-ce4644875dd5 (uber "Danish Rehman Rehman")
--   -> 67483c64055e070d79100111 (hotel "DANISH REHMAN HAJI REHMAN") = 'danish rehman haji rehman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6623840 (bolt "Danish Rehman")
--   -> 67483c64055e070d79100111 (hotel "DANISH REHMAN HAJI REHMAN") = 'danish rehman haji rehman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6615750 (bolt "Mohammad Naeem Adam Khan")
--   -> 67483c64055e070d79100117 (hotel "MOHAMMAD NAEEM ADAM KHAN") = 'mohammad naeem adam khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8108061 (bolt "Chingiz Saftarov")
--   -> 8b41f469-689e-455d-8b00-ff2a37d9a7ec (uber "Chingiz Seftarov") = 'chingiz seftarov'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 4ca00da1-292a-464e-82c5-f7702b135331 (bolt "Chingiz Saftarov")
--   -> 8b41f469-689e-455d-8b00-ff2a37d9a7ec (uber "Chingiz Seftarov") = 'chingiz seftarov'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 41dd8378ea3a4998a7a1ad70cf1656ba (yango "MUHAMMAD ISHTIAQ")
--   -> d1925319-0544-48c6-a2fb-a9098f311a65 (uber "Muhammad Ishtiaq Khan") = 'muhammad ishtiaq khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7569135 (bolt "Aman Ullah Amir Mehboob Alam")
--   -> 68766d7d03051f14d95a8209 (hotel "Aman Ullah Amir Mehboob Alam") = 'aman ullah amir mehboob alam'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6610828 (bolt "Abdul Hannan Momin Humayun Habib Momin")
--   -> ea186ae2-197c-4a1c-a1cd-ae56643e6f73 (uber "Abdul Hannan Momin") = 'abdul hannan momin'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6901251 (bolt "Jawad Khan Ali Gohar")
--   -> 1c16bca7-d064-42b6-bc63-04758e74a06e (uber "Jawad Khan Gohar") = 'jawad khan gohar'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-22
-- 68766b8003051f14d95a81dc (hotel "Jawad Khan Ali Gohar")
--   -> 1c16bca7-d064-42b6-bc63-04758e74a06e (uber "Jawad Khan Gohar") = 'jawad khan gohar'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-10-22
-- 6610637 (bolt "Zain Ul Abideen Muhammad Irfan")
--   -> 67483c64055e070d791000df (hotel "ZAIN UL ABIDEEN MUHAMMAD IRFAN") = 'zain ul abideen muhammad irfan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6997157 (bolt "Muhammad Faraz Khan Muhammad Farooq Khan")
--   -> c4febff7-604d-4ce8-90db-d0730bcac155 (uber "Muhammad Faraz Khan") = 'muhammad faraz khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 35067d2a-3f1e-402e-97f3-fc87657c8153 (bolt "Muhammad Faraz Khan Muhammad Farooq Khan")
--   -> c4febff7-604d-4ce8-90db-d0730bcac155 (uber "Muhammad Faraz Khan") = 'muhammad faraz khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6610628 (bolt "Kazi Fuad Ahmed Kazi Alim Ullah")
--   -> 67483c64055e070d791000ca (hotel "Kazi Fuad Ahmed Kazi Alim Ullah") = 'kazi fuad ahmed kazi alim ullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- a9634a34f151436da7669fda9cc58bbc (yango "KAZI AHMED")
--   -> 67483c64055e070d791000ca (hotel "Kazi Fuad Ahmed Kazi Alim Ullah") = 'kazi fuad ahmed kazi alim ullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6633745 (bolt "Muhammad Ihtisham Muhammad Zaman")
--   -> a0644707-82d1-496b-b6eb-656d9b3b32ef (uber "Muhammad Ihtisham Zaman") = 'muhammad ihtisham zaman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d7910012b (hotel "MUHAMMAD IHTISHAM MUHAMMAD ZAMAN")
--   -> a0644707-82d1-496b-b6eb-656d9b3b32ef (uber "Muhammad Ihtisham Zaman") = 'muhammad ihtisham zaman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611196 (bolt "Arivoli Rajendran Rajendran")
--   -> 2d4e39b2-43cb-4e51-ac1f-cd4fc0612528 (uber "Arivoli Rajendran Rajendran") = 'arivoli rajendran'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- fb82dc91-90f6-4f1b-9793-b97ccea96640 (bolt "Arivoli Rajendran Rajendran")
--   -> 2d4e39b2-43cb-4e51-ac1f-cd4fc0612528 (uber "Arivoli Rajendran Rajendran") = 'arivoli rajendran'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7636498 (bolt "Muhammad Talha Mummar Shah Qureshi")
--   -> 9afe2406-3ca9-4061-96c2-fa0e1db93720 (uber "Muhammad Talha Qureshi") = 'muhammad talha qureshi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 688218d1a0bf23d354fd7014 (hotel "Muhammad Talha Mummar Shah Qureshi")
--   -> 9afe2406-3ca9-4061-96c2-fa0e1db93720 (uber "Muhammad Talha Qureshi") = 'muhammad talha qureshi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 812895dc-41b5-4c11-bcb4-fdfdc308c73e (bolt "Muhammad Talha Mummar Shah Qureshi")
--   -> 9afe2406-3ca9-4061-96c2-fa0e1db93720 (uber "Muhammad Talha Qureshi") = 'muhammad talha qureshi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6907719 (bolt "Saad Ali Akram Muhammad Akram Bhatti")
--   -> 67483c64055e070d791000d9 (hotel "SAAD ALI AKRAM MUHAMMAD AKRAM BHATTI") = 'saad ali akram muhammad akram bhatti'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- dd4a45c2d6f3449da9807d81558ecbd2 (yango "Saad Ali Akram")
--   -> 67483c64055e070d791000d9 (hotel "SAAD ALI AKRAM MUHAMMAD AKRAM BHATTI") = 'saad ali akram muhammad akram bhatti'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8168176 (bolt "Abdul Basit Aman")
--   -> 6d609028-a86c-4cee-92ef-7bae26e0cca8 (uber "Abdul Basit Aman") = 'abdul basit aman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6814489 (bolt "Irfan Ullah Awal Ameen")
--   -> 04c30a0a-1d4f-40f3-b9aa-378ed5ceeee4 (uber "Irfan Ullah Awal Ameen") = 'irfan ullah awal ameen'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- f7aad3d6075f4e788a303ce744d9986c (yango "IRFAN ULLAH")
--   -> 04c30a0a-1d4f-40f3-b9aa-378ed5ceeee4 (uber "Irfan Ullah Awal Ameen") = 'irfan ullah awal ameen'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6610644 (bolt "Khalid Abdalrahman Basher Albadwi")
--   -> fc05f592-46a1-4353-b843-88e5c6dbec2c (uber "Khalid Abdalrahman Albadwi") = 'khalid abdalrahman albadwi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000c7 (hotel "Khalid Abdalrahman Basher Albadwi")
--   -> fc05f592-46a1-4353-b843-88e5c6dbec2c (uber "Khalid Abdalrahman Albadwi") = 'khalid abdalrahman albadwi'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6600403 (bolt "MOHAMMAD RAHIM SHAHZAD ABDUL RAUF")
--   -> e3c961d9-9bfa-439e-b711-32f825a085d5 (uber "Muhammad Rahim Rauf") = 'muhammad rahim rauf'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 4ea45e6f-f67f-4484-b5cf-f254e618eeab (bolt "MOHAMMAD RAHIM SHAHZAD ABDUL RAUF")
--   -> e3c961d9-9bfa-439e-b711-32f825a085d5 (uber "Muhammad Rahim Rauf") = 'muhammad rahim rauf'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9048366 (bolt "Edwin Nyasani Mandere")
--   -> 6a48ed8f13880329d04ebbbd (hotel "Edwin Nyasani Mandere") = 'edwin nyasani mandere'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7874167 (bolt "Muhammad Zeeshan Ahmed Muhammad Shahid")
--   -> 4d57e153e6ff455782e4954a7862099a (yango "Muhammad Zeeshan Muhammad Shahid") = 'muhammad zeeshan muhammad shahid'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6a4e97abb3b4e99c0391914e (hotel "Muhammad Zeeshan Ahmed Shahid")
--   -> 4d57e153e6ff455782e4954a7862099a (yango "Muhammad Zeeshan Muhammad Shahid") = 'muhammad zeeshan muhammad shahid'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6785544 (bolt "Wajahat Ur Rehman Munir Khan")
--   -> eeaac51c-2c12-48cf-aee7-5593ee6573ad (uber "Wajahat Khan") = 'wajahat khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- a206c164ad194fe385209d40a17e5246 (yango "wajahat ur rehman")
--   -> eeaac51c-2c12-48cf-aee7-5593ee6573ad (uber "Wajahat Khan") = 'wajahat khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000e6 (hotel "WAJAHAT UR REHMAN MUNIR KHAN")
--   -> eeaac51c-2c12-48cf-aee7-5593ee6573ad (uber "Wajahat Khan") = 'wajahat khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8110251 (bolt "Abusaad Siddiqui Akhlaque Ahmad")
--   -> 68f744f88c482942eaaba18b (hotel "Abusaad Siddiqui Akhlaque Ahmad") = 'abusaad siddiqui akhlaque ahmad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- d6892f17ac534650b6855ffa3161f6bb (yango "Abusaad Siddiqui Akhlaque Ahmad")
--   -> 68f744f88c482942eaaba18b (hotel "Abusaad Siddiqui Akhlaque Ahmad") = 'abusaad siddiqui akhlaque ahmad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7202128 (bolt "Ali Raza Shah Muhammad Sadiq Shah")
--   -> 3cf1fcd4-1087-4b72-8598-6dffe3fe86e0 (uber "Ali Raza Shah") = 'ali raza shah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 0cb17332-9d08-4d1e-8806-898ad47d784d (bolt "Ali Raza Shah Muhammad Sadiq Shah")
--   -> 3cf1fcd4-1087-4b72-8598-6dffe3fe86e0 (uber "Ali Raza Shah") = 'ali raza shah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9131685 (bolt "Norah Chia Nsom")
--   -> 8daae9c7-5a34-4e67-a178-565b92191461 (uber "Norah Chia Nsom") = 'norah chia nsom'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2026-09-03
-- 6aa01aee0b289436de6ec0d2 (hotel "Muhammad Sheraz Amir Muhammad")
--   -> d4862a73-6317-4fa8-ad19-8c7a95e9e74d (uber "Muhammad sheraz Muhammad") = 'muhammad sheraz muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6864801 (bolt "Muhammad Ali Maqsood Ahmad Tariq Bajwa")
--   -> 03e77aa0-87b4-4a8a-a2ec-2784d831c4f8 (uber "Muhammad Ali Bajwa") = 'muhammad ali bajwa'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6623648 (bolt "Zahid Ezaz Ezazullah")
--   -> 1da7bc60-8f0c-47e5-a25d-e7e30647faed (uber "Zahid  Ezaz Ezazullah") = 'zahid ezazullah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6623561 (bolt "Atif Shabbir")
--   -> a5465ff1-317a-4d67-ac54-cce9999f725c (uber "Atif Shabbir Shabbir") = 'atif shabbir'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6934090 (bolt "Maqsood Muhabat Shah Muhabat Shah")
--   -> bed790a1-d986-4b0d-b6a3-5f9854789263 (uber "Maqsood Muhabat Shah") = 'maqsood muhabat shah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7416662 (bolt "Mansoor Mohammad Naeem")
--   -> fd0284aa-489a-4e53-aa9d-23c2512fe2dd (uber "Mansoor Mohammad Naeem") = 'mansoor mohammad naeem'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- ba2f3489-1277-4a64-9671-f800173b0aae (bolt "Mansoor Mohammad Naeem")
--   -> fd0284aa-489a-4e53-aa9d-23c2512fe2dd (uber "Mansoor Mohammad Naeem") = 'mansoor mohammad naeem'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9324842 (bolt "Muhammad Ahmad Ghulam Qadir")
--   -> 6a7f3e80d87732ee9b2068a3 (hotel "MUHAMMAD AHMAD GHULAM QADIR") = 'muhammad ahmad ghulam qadir'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7523326 (bolt "Cedric Wendkuni Kabore")
--   -> 8e4e351c-aba6-4141-994f-55cffd844191 (uber "Cedric Wendkuni Kabore") = 'cedric wendkuni kabore'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 68766c9e03051f14d95a81f4 (hotel "Cedric Wendkuni Kabore")
--   -> 8e4e351c-aba6-4141-994f-55cffd844191 (uber "Cedric Wendkuni Kabore") = 'cedric wendkuni kabore'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- c9948e92-9d32-40bb-91ec-1b3d124647f9 (uber "Muhammad Masood Khan")
--   -> 67483c64055e070d791000d7 (hotel "MUHAMMAD MASOOD KISHBAR KHAN") = 'muhammad masood kishbar khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628159 (bolt "Muhammad Masood Kishbar Khan")
--   -> 67483c64055e070d791000d7 (hotel "MUHAMMAD MASOOD KISHBAR KHAN") = 'muhammad masood kishbar khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6640621 (bolt "Muhammad Amir Misree Khan")
--   -> 67483c64055e070d791000d3 (hotel "MUHAMMAD AMIR MISREE KHAN") = 'muhammad amir misree khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8203414 (bolt "Rashid Ali Haji Hussain")
--   -> 43183d548e3e487b9a5227705ace4719 (yango "Rashid Ali Haji Hussain") = 'rashid ali haji hussain'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8410975 (bolt "Sar Zamin Khan Shah Bahadar")
--   -> 69411d3a8c482942eaaf083e (hotel "Sar Zamin Khan Shah Bahadar") = 'sar zamin khan shah bahadar'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8fb45c4e-a2ab-413b-9069-355902279de9 (uber "Sameh Talaat Abdelsamie")
--   -> 67483c64055e070d7910010f (hotel "SAMEH TALAAT ABDELMAKSOUD ABDELSAMIE") = 'sameh talaat abdelmaksoud abdelsamie'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628152 (bolt "SAMEH TALAAT ABDELMAKSOUD ABD ELSAMIE")
--   -> 67483c64055e070d7910010f (hotel "SAMEH TALAAT ABDELMAKSOUD ABDELSAMIE") = 'sameh talaat abdelmaksoud abdelsamie'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9492548 (bolt "Saddam Hussain Muhammad islam")
--   -> 5621f561-9a06-42ad-a85e-c10a751bb216 (uber "Saddam Hussain Islam") = 'saddam hussain islam'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 494e1f9c-909d-453e-8588-8c12b4c0ddcc (bolt "Saddam Hussain Muhammad islam")
--   -> 5621f561-9a06-42ad-a85e-c10a751bb216 (uber "Saddam Hussain Islam") = 'saddam hussain islam'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628537 (bolt "ZIA ULLAH NASRULLAH KHAN")
--   -> f01ca0ae-6f62-406e-8115-a881f33a811e (uber "Zia Ullah Nasrullah Khan") = 'zia ullah nasrullah khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 805583c3bc6e450aa33ad320e991e714 (yango "ZIA ULLAH")
--   -> f01ca0ae-6f62-406e-8115-a881f33a811e (uber "Zia Ullah Nasrullah Khan") = 'zia ullah nasrullah khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d79100108 (hotel "ZIA ULLAH NASRULLAH KHAN Nasrullah")
--   -> f01ca0ae-6f62-406e-8115-a881f33a811e (uber "Zia Ullah Nasrullah Khan") = 'zia ullah nasrullah khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7300699 (bolt "Muhammad Hasham Tanveer Tanveer Ahmad Khan")
--   -> 67483c64055e070d791000e2 (hotel "MUHAMMAD HASHAM TANVEER TANVEER AHMAD KHAN") = 'muhammad hasham tanveer ahmad khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- fa1379f659d343409a1807a4e0e2e1fd (yango "Sabbir Shahalom")
--   -> 006e7f5c-f7c4-45f2-bd00-336121105d3f (uber "Sabbir Hossain Shahalom") = 'sabbir hossain shahalom'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6880673 (bolt "HASSAN MUNAWAR MUNAWAR AHMED SHAAD")
--   -> 454fefba-ff66-4995-b9c5-f70d1fda7dd5 (uber "Hassan Munawar Shaad") = 'hassan munawar shaad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- f157aac8-ff4d-489d-9d35-1d96ffc5e4ca (bolt "HASSAN MUNAWAR MUNAWAR AHMED SHAAD")
--   -> 454fefba-ff66-4995-b9c5-f70d1fda7dd5 (uber "Hassan Munawar Shaad") = 'hassan munawar shaad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d79100124 (hotel "IMAD KHAN DARWISH KHAN")
--   -> 6628162 (bolt "Imad Khan Darwish Khan") = 'imad khan darwish khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9081508 (bolt "Zain Hassan Raja Nasrullah Khan")
--   -> c873a0fe-fea0-47a1-8b0d-e620e9675610 (uber "Zain Hassan Raja Nasrullah Khan") = 'zain hassan raja nasrullah khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 36f2a997f1ef434fa3fbd2d63d945c05 (yango "Zain Raja")
--   -> c873a0fe-fea0-47a1-8b0d-e620e9675610 (uber "Zain Hassan Raja Nasrullah Khan") = 'zain hassan raja nasrullah khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 0a688852-8cbb-4661-ae26-a2a0057b2690 (uber "Rizwan Ullah Muzamil Khan")
--   -> 67483c64055e070d79100118 (hotel "Rizwan Ullah Muzamil Khan") = 'rizwan ullah muzamil khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6623653 (bolt "RIZWAN ULLAH MUZAMIL KHAN")
--   -> 67483c64055e070d79100118 (hotel "Rizwan Ullah Muzamil Khan") = 'rizwan ullah muzamil khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6901485 (bolt "Abdelmohsen Said Abdelmohsen Mohamed Salem")
--   -> a7ee8da6-f312-4b76-b925-f6682e2fed12 (uber "Abdelmohsen Said Ghanem") = 'abdelmohsen said ghanem'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 785f350f-47d2-4b3a-99a5-923f01d8f7c9 (bolt "Abdelmohsen Said Abdelmohsen Mohamed Salem")
--   -> a7ee8da6-f312-4b76-b925-f6682e2fed12 (uber "Abdelmohsen Said Ghanem") = 'abdelmohsen said ghanem'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9481149 (bolt "Wunibie Mohammed Issah")
--   -> c0520901-3066-4f65-977c-a40e324e38ae (uber "Wunibie Mohammed Issah") = 'wunibie mohammed issah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 76f1b791-52ad-4c1a-899c-c2b9c2d8db36 (bolt "Wunibie Mohammed Issah")
--   -> c0520901-3066-4f65-977c-a40e324e38ae (uber "Wunibie Mohammed Issah") = 'wunibie mohammed issah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6835351 (bolt "Ubaid Ullah Hassan Muhammad")
--   -> 9cf2c3e7-896a-4265-9600-0a5c16bbc9fe (uber "Ubaid Ullah Hassan Muhammad") = 'ubaid ullah hassan muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000ce (hotel "UBAID ULLAH HASSAN MUHAMMAD")
--   -> 9cf2c3e7-896a-4265-9600-0a5c16bbc9fe (uber "Ubaid Ullah Hassan Muhammad") = 'ubaid ullah hassan muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9503883 (bolt "Sebastian Jerones Jerones")
--   -> 1b7f45d7-1638-4f3a-a254-8d8b3b922ff7 (uber "Sebastian  Jerones Jerones") = 'sebastian jerones'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- a4da2085550d423f9c20d374473e474f (yango "MAJID SHAH")
--   -> 67483c64055e070d791000ee (hotel "MAJID SHAH MEHBOOB SHAH") = 'majid shah mehboob shah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8348168 (bolt "Nizam Wazir Zada")
--   -> cc926625-4342-4b87-8311-07fc765ffddf (uber "Nizam Wazir Zada") = 'nizam wazir zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2026-08-26
-- 693a7cea8c482942eaaec601 (hotel "Nizam Wazir Zada")
--   -> cc926625-4342-4b87-8311-07fc765ffddf (uber "Nizam Wazir Zada") = 'nizam wazir zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2026-08-26
-- 6cf65aa1-b9b6-4efc-b006-a0a4bde7a2f4 (bolt "Muhammad Hussnain Muhammad Rafique")
--   -> 6594329 (bolt "Muhammad Hussnain Muhammad Rafique") = 'muhammad hussnain muhammad rafique'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628172 (bolt "Muhammad Aqib Ahmad Ullah Khan")
--   -> b2093c44-92a7-4d03-8c43-0b28ac199252 (uber "Muhammad Aqib Khan") = 'muhammad aqib khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6623720 (bolt "MUHAMMAD SHAHAB GHARIB KHAN")
--   -> c35f5806-b4a3-41a3-8c84-b1ab7dcfbfa5 (uber "Muhammed SHAHAB KHAN") = 'muhammed shahab khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 688b20bea0bf23d354fdbaca (hotel "Muhammad Shahab Gharib Khan")
--   -> c35f5806-b4a3-41a3-8c84-b1ab7dcfbfa5 (uber "Muhammed SHAHAB KHAN") = 'muhammed shahab khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7714111 (bolt "Abas Osman Abyan")
--   -> c417490e-a60a-4fb3-b4d8-c16673008e0a (uber "Abas Osman Abyan") = 'abas osman abyan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- bb9ef8895f9e4e5c8947258ef0ae1503 (yango "Abyan Abas Osman")
--   -> c417490e-a60a-4fb3-b4d8-c16673008e0a (uber "Abas Osman Abyan") = 'abas osman abyan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6800964 (bolt "Sheraz Rehman Abdul Rehman Khan")
--   -> 2c445083-99b6-411f-bd9d-5b6823b80b9d (uber "Sheraz Rehman Khan") = 'sheraz rehman khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- cbc987fdf3164305b62700b707905664 (yango "Altabei Sameh")
--   -> 6628155 (bolt "Sameh Altabei Elsayed Mohamed") = 'sameh altabei elsayed mohamed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611334 (bolt "Abdul Salim Aziz Abdul Aziz Abdul Gaffur")
--   -> 55833ba1-0dcb-4a6a-a7f0-5148819e600d (uber "Abdul Salim Aziz Abdul Gaffur") = 'abdul salim aziz abdul gaffur'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 92a8c1c8-f5ab-462a-99a3-165dc3fbe6c2 (bolt "Abdul Salim Aziz Abdul Aziz Abdul Gaffur")
--   -> 55833ba1-0dcb-4a6a-a7f0-5148819e600d (uber "Abdul Salim Aziz Abdul Gaffur") = 'abdul salim aziz abdul gaffur'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8035834 (bolt "Muhammad Haris Bangash Iftikhar Ahmad Bangash")
--   -> 4392d188-e2fb-4a7d-999d-693e648b4e55 (uber "Muhammad Haris Bangash") = 'muhammad haris bangash'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 87a43a33-2869-44ba-94d5-c9109c308daa (bolt "Muhammad Haris Bangash Iftikhar Ahmad Bangash")
--   -> 4392d188-e2fb-4a7d-999d-693e648b4e55 (uber "Muhammad Haris Bangash") = 'muhammad haris bangash'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6611221 (bolt "Durga Prasad Basyal")
--   -> 67483c64055e070d791000cb (hotel "DURGA PRASAD BASYAL") = 'durga prasad basyal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 4abd6016-c582-44f9-8bf7-6af054d0cbe6 (uber "Durga Prasad Basyal")
--   -> 67483c64055e070d791000cb (hotel "DURGA PRASAD BASYAL") = 'durga prasad basyal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628957 (bolt "Umar Ali Zarid Khan")
--   -> 67483c64055e070d791000f8 (hotel "Umar Ali Zarid Khan") = 'umar ali zarid khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7859266 (bolt "Umer Ali Zarid Khan")
--   -> 67483c64055e070d791000f8 (hotel "Umar Ali Zarid Khan") = 'umar ali zarid khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 23a584f3-cfc7-450e-bb42-6a71ebf0d613 (uber "Abdullah Ahmed Khan")
--   -> 67483c64055e070d7910010e (hotel "ABDULLAH AHMAD AHMAD ULLAH KHAN") = 'abdullah ahmad ullah khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628743 (bolt "Abdullah Ahmad Ahmad Ullah Khan")
--   -> 67483c64055e070d7910010e (hotel "ABDULLAH AHMAD AHMAD ULLAH KHAN") = 'abdullah ahmad ullah khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8170855 (bolt "Elchin Goyushov")
--   -> 5ab414ab-e448-420e-9701-721d4cac42fb (uber "Elchin Goyushov") = 'elchin goyushov'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- a4fb427a-514a-476f-9e5f-6498367f327e (bolt "Elchin Goyushov")
--   -> 5ab414ab-e448-420e-9701-721d4cac42fb (uber "Elchin Goyushov") = 'elchin goyushov'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d79100121 (hotel "ZAHID KHAN ISMAIL ISMAIL")
--   -> 992df6d8-7069-409c-b93d-3f638817ac49 (uber "ZAHID KHAN ISMAIL ISMAIL") = 'zahid khan ismail'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-04-07, 2025-04-25, 2025-04-29
-- 9593727 (bolt "Dev Bahadur Gurung")
--   -> a5f9214e-4f6f-4037-bf0a-631bc6ff5343 (uber "Dev Bahadur Gurung") = 'dev bahadur gurung'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 93378ac8-6756-439c-9c92-e298ece77c33 (bolt "Dev Bahadur Gurung")
--   -> a5f9214e-4f6f-4037-bf0a-631bc6ff5343 (uber "Dev Bahadur Gurung") = 'dev bahadur gurung'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6659711 (bolt "Noor Ullah Khan Sherin Zaman")
--   -> 6fa73403-4c89-4be6-83ca-dada5205a0a7 (uber "NoorUllah KHAN ZAMAN") = 'noorullah khan zaman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d79100102 (hotel "NOOR ULLAH KHAN SHERIN ZAMAN")
--   -> 6fa73403-4c89-4be6-83ca-dada5205a0a7 (uber "NoorUllah KHAN ZAMAN") = 'noorullah khan zaman'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8074227 (bolt "Muhammad Nadeem Muhammad Ajmal")
--   -> 1936ced0-ccd5-4db0-b07f-ab084cee7bd9 (uber "Muhammad Nadeem Ajmal") = 'muhammad nadeem ajmal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6623712 (bolt "Ansar Murtaza")
--   -> 67483c64055e070d791000e0 (hotel "ANSAR MURTAZA BUTT RASHID MURTAZA") = 'ansar murtaza butt rashid murtaza'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- e2e561163b1b40aaa79b82a87be40f6b (yango "ANSAR MURTAZA")
--   -> 67483c64055e070d791000e0 (hotel "ANSAR MURTAZA BUTT RASHID MURTAZA") = 'ansar murtaza butt rashid murtaza'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6c861462-33fa-4da4-9ef6-5d0f8d372633 (uber "Haider Ali Mahmood")
--   -> 6633411 (bolt "Haider Ali Khalid Mahmood") = 'haider ali khalid mahmood'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d7910010c (hotel "HAIDER ALI KHALID MAHMOOD")
--   -> 6633411 (bolt "Haider Ali Khalid Mahmood") = 'haider ali khalid mahmood'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6a042a98284c6a4354627f36 (hotel "Moidutty Sanafu Cherunambi")
--   -> 22a30136-f671-4d0f-a78e-109d255769b3 (uber "Moidutty Sanafu Moidutty") = 'moidutty sanafu moidutty'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7158151 (bolt "Wajid Akbar Akbar Din Khan")
--   -> 00dc098e-2f65-4b6b-9fbd-47305cdb18e0 (uber "Wajid Akbar Khan") = 'wajid akbar khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 221b1276-c0de-43ef-973c-0e536460337d (bolt "FAIZAN WARIS MUHAMMAD WARIS")
--   -> 6592207 (bolt "FAIZAN WARIS MUHAMMAD WARIS") = 'faizan waris muhammad waris'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 5edfb1b3-25a5-42f7-9759-4f3e4f22c4d6 (bolt "Leon Anthony rodrigues Rodrigues Anthony marcus")
--   -> 97e08f41-1b0c-44b5-98bd-bfdea50a2c24 (uber "Leon Anthony Marcus") = 'leon anthony marcus'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8274586 (bolt "Muhammad Rashid Muhammad Riasat")
--   -> 4a4a43d2-1c84-4b62-9475-7c08b5cecd78 (uber "Muhammad Rashid Riasat") = 'muhammad rashid riasat'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- e125d722-cd21-4636-a38c-b2c54494c89f (bolt "Muhammad Rashid Muhammad Riasat")
--   -> 4a4a43d2-1c84-4b62-9475-7c08b5cecd78 (uber "Muhammad Rashid Riasat") = 'muhammad rashid riasat'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6639693 (bolt "Muhammad Abid Ali Khan Noor Zali Khan")
--   -> 67483c64055e070d791000de (hotel "MUHAMMAD ABID ALI KHAN NOOR NOOR") = 'muhammad abid ali khan noor'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6620175 (bolt "Nosher Hassan Mumtaz Ahmad Bhatti")
--   -> 4cbf0c03-1666-444e-a164-310bb80fedf5 (uber "Nosher Hassan Bhatti") = 'nosher hassan bhatti'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8519700 (bolt "Fahad Mustafa")
--   -> 41fab64a-e93c-4f7b-847b-513f01084fda (uber "Fahad Mustafa Mustafa") = 'fahad mustafa'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 11ebc40b-25cf-47db-91a3-8705c70ee4ef (bolt "Fahad Mustafa")
--   -> 41fab64a-e93c-4f7b-847b-513f01084fda (uber "Fahad Mustafa Mustafa") = 'fahad mustafa'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9674928 (bolt "JAVEED AHMED")
--   -> 924ba67f-0ebf-48eb-b30b-0feffe302088 (uber "Javeed Ahmed Abuthahir") = 'javeed ahmed abuthahir'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6ac5f35a6e0dbece4b48591e (hotel "Javeed Ahmed Syed Abuthahir Syed Abuthahir")
--   -> 924ba67f-0ebf-48eb-b30b-0feffe302088 (uber "Javeed Ahmed Abuthahir") = 'javeed ahmed abuthahir'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7194959 (bolt "Muhammad Sabir Bakht Jamal")
--   -> 716b5404-628d-47e4-827e-1477749eb75f (uber "Muhammad Sabir Jamal") = 'muhammad sabir jamal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- bfb35d1b-be59-4abe-9d35-41870fcd1863 (bolt "Muhammad Sabir Bakht Jamal")
--   -> 716b5404-628d-47e4-827e-1477749eb75f (uber "Muhammad Sabir Jamal") = 'muhammad sabir jamal'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- cf47057f-57d4-480c-b581-23edc94a542a (bolt "Maimaitiyiming Abuduhaibaier")
--   -> 6997355 (bolt "Maimaitiyiming Abuduhaibaier") = 'maimaitiyiming abuduhaibaier'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- b4f0558b-284b-4d91-b40a-5ed7b8c11c67 (bolt "Dhavooth Ibrahim")
--   -> 8875bda1-9a0a-4337-adbb-43926ad278ea (uber "Dhavooth Ibrahim Abdul Kadhar") = 'dhavooth ibrahim abdul kadhar'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6940023 (bolt "Umair Uddin Mohammed Mohammed Zameer Uddin")
--   -> 84f3c41d-2e32-432d-8d6a-a565184d1068 (uber "Umairuddin Mohammed Zameeruddin") = 'umairuddin mohammed zameeruddin'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 2df8f636-2964-4163-a164-b09154f92c80 (bolt "Umair Uddin Mohammed Mohammed Zameer Uddin")
--   -> 84f3c41d-2e32-432d-8d6a-a565184d1068 (uber "Umairuddin Mohammed Zameeruddin") = 'umairuddin mohammed zameeruddin'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8051700 (bolt "Mohammad Asif Shafiq Ahmad")
--   -> 7c19932d-f2de-45a2-ad08-b01a4b87b988 (uber "Mohammad Asif Ahmad") = 'mohammad asif ahmad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 90c2e390-2820-4d26-8cf3-2b84ca717c55 (bolt "Mohammad Asif Shafiq Ahmad")
--   -> 7c19932d-f2de-45a2-ad08-b01a4b87b988 (uber "Mohammad Asif Ahmad") = 'mohammad asif ahmad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6a291640284c6a4354651585 (hotel "SHAHID KHAN KHAN ZADA")
--   -> eb7962e5-0c47-45c0-b758-b61e6dd12998 (uber "SHAHID KHAN KHAN ZADA") = 'shahid khan zada'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7312220 (bolt "Muhammad Nasir Bashir Khan")
--   -> 7a935b56-6a30-4f25-9d0a-d556b947e23a (uber "Muhammad Nasir Khan") = 'muhammad nasir khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- b5c7ce92-b5fd-4e08-bc9b-09bcc37f1ac3 (bolt "Muhammad Nasir Bashir Khan")
--   -> 7a935b56-6a30-4f25-9d0a-d556b947e23a (uber "Muhammad Nasir Khan") = 'muhammad nasir khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7547689 (bolt "Arslan Arif Muhammad Arif")
--   -> dbd55f2e-ffeb-479d-b8f0-75c8acf186b5 (uber "Arslan Arif Arif") = 'arslan arif'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 92ec45d804f34718a8ed6214cfb99b4d (yango "Muhammad Arif Arslan Arif")
--   -> dbd55f2e-ffeb-479d-b8f0-75c8acf186b5 (uber "Arslan Arif Arif") = 'arslan arif'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8033691 (bolt "Muhammad Usman Azmat Khan")
--   -> 67e086af-8cb7-498f-9f4f-f4d4e2a7467a (uber "Muhammad Usman Khan") = 'muhammad usman khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 3d226bd8-47bf-4d9e-b4d2-722756144ee9 (bolt "Muhammad Usman Azmat Khan")
--   -> 67e086af-8cb7-498f-9f4f-f4d4e2a7467a (uber "Muhammad Usman Khan") = 'muhammad usman khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7416327 (bolt "Younas Khan Islam Shah")
--   -> e6c4ae1e-b424-4b42-ad68-153dc8f7b823 (uber "Younas Khan Shah") = 'younas khan shah'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 9642366 (bolt "Muhammad Asim")
--   -> 42316a17-6fc9-49f4-af07-b5676ac04eeb (uber "Muhammad Asim Shahzad") = 'muhammad asim shahzad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6f564b8c1a334a7eb9953614300d8e85 (yango "YOUSAF ALI")
--   -> 6629009 (bolt "YOUSAF ALI JAVED IQBAL KHAN") = 'yousaf ali javed iqbal khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7294843 (bolt "Hassan Elsayed Gaber Hassan Hassan")
--   -> 19a4453f-a38b-4142-93f5-979b96b681a6 (uber "Hassan Elsayed Hassan") = 'hassan elsayed hassan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 83cf7ce5-764e-4588-994f-d415566288c1 (bolt "Hassan Elsayed Gaber Hassan Hassan")
--   -> 19a4453f-a38b-4142-93f5-979b96b681a6 (uber "Hassan Elsayed Hassan") = 'hassan elsayed hassan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 413c9c74-c8dc-402e-98dd-7317c9855d33 (bolt "Emad Alabdon")
--   -> f77be3df-b458-4a53-94f3-e892dbb495cb (uber "Emad Alabdon") = 'emad alabdon'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 7643640 (bolt "Mohammed Musab Rahmathulla")
--   -> 2c085db3-dbb1-48a6-99ca-0af7e5ee3ea5 (uber "Mohammed Musab Rahmathulla") = 'mohammed musab rahmathulla'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 2bde54e1ec3d46e787c3562a15459a16 (yango "MOHAMMED MUSAB")
--   -> 2c085db3-dbb1-48a6-99ca-0af7e5ee3ea5 (uber "Mohammed Musab Rahmathulla") = 'mohammed musab rahmathulla'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 0f314ca4-fedd-4de5-9b48-59f274776381 (bolt "shajahan Mk")
--   -> 9585892 (bolt "shajahan Mk") = 'shajahan mk'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 00c0221c4aec47db9813f6c525167561 (yango "M MAEN M ALAA SHEKFA")
--   -> 67483c64055e070d79100133 (hotel "M MAEN M ALAA SHEKFA") = 'maen m alaa shekfa'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628845 (bolt "M MEAN M ALAA SHEKFA")
--   -> 67483c64055e070d79100133 (hotel "M MAEN M ALAA SHEKFA") = 'maen m alaa shekfa'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- d43a09f3ab8a44b5ab6d35331edb59af (yango "FARHAN KHAN")
--   -> 6628886 (bolt "Farhan Khan Manazir Khan") = 'farhan khan manazir khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8af4f8d8-c28b-4eef-be5b-609947c9567c (bolt "Moidutty sanafu Cherunambi moidutty")
--   -> 8688313 (bolt "Moidutty sanafu Cherunambi moidutty") = 'moidutty sanafu cherunambi moidutty'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628548 (bolt "Umar Kayani Nasir Waheed Kayani")
--   -> 67483c64055e070d791000da (hotel "UMAR KAYANI NASIR WAHEED KAYANI") = 'umar kayani nasir waheed kayani'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8555822 (bolt "Alzain Hussein")
--   -> 8d545a2e-725f-488d-9498-0870a0bffb87 (uber "Alzain Alfatih Ahmed") = 'alzain alfatih ahmed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 2b53af79-175b-4ff4-bd2e-545c2d409ce9 (bolt "Alzain Hussein")
--   -> 8d545a2e-725f-488d-9498-0870a0bffb87 (uber "Alzain Alfatih Ahmed") = 'alzain alfatih ahmed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 4e75cfb248fc45dd8bc41c460e956bfb (yango "Ghulam Muhammad Ahmed")
--   -> f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2 (uber "Shehzad Ahmad Ghulam Muhammad") = 'shehzad ahmad ghulam muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- b826dc16c41248b1a5005750d255231b (yango "Shehzad Ahmad")
--   -> f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2 (uber "Shehzad Ahmad Ghulam Muhammad") = 'shehzad ahmad ghulam muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 8519699 (bolt "Khan Akbar")
--   -> be22c2b6-fd77-4956-9b72-139eeb61d71f (uber "Khan Akbar Khan") = 'khan akbar khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 1f1bb8d4-9a08-41ae-b376-0135ca67a431 (bolt "Khan Akbar")
--   -> be22c2b6-fd77-4956-9b72-139eeb61d71f (uber "Khan Akbar Khan") = 'khan akbar khan'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 34e629f1fab64e9a814089dc0d2a086d (yango "Rufat Gadirli")
--   -> 6628166 (bolt "Rufat Gadirli") = 'rufat gadirli'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 808537b4-e268-4c3c-bac1-fc1cf6c74004 (bolt "Binu Abdul Rehman Kunju Abdul Rahman Kunju")
--   -> 06e30918-61b9-4543-8a38-b7ff787c1b44 (uber "Binu Abdul Rehman Kunju Abdul Rahman Kunju") = 'binu abdul rehman kunju abdul rahman kunju'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6628589 (bolt "Nauman Hassan Shida Muhammad")
--   -> 67483c64055e070d791000f9 (hotel "NAUMAN HASSAN SHIDA MUHAMMAD") = 'nauman hassan shida muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 72caf703fcf64d63965b80a6497428ac (yango "HASSAN NAUMAN")
--   -> 67483c64055e070d791000f9 (hotel "NAUMAN HASSAN SHIDA MUHAMMAD") = 'nauman hassan shida muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6616332 (bolt "Sayed Kamal Sayed Sayed Mir Sayed")
--   -> b7310a42-4ad3-4c88-b1ce-4fa50e226077 (uber "Sayed Kamal Sayed") = 'sayed kamal sayed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000fa (hotel "SAYED KAMAL SAYED SAYED MIR SAYED")
--   -> b7310a42-4ad3-4c88-b1ce-4fa50e226077 (uber "Sayed Kamal Sayed") = 'sayed kamal sayed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 36aace666f914d8db5d3e5be3bb6f7fd (yango "sayed kamal")
--   -> b7310a42-4ad3-4c88-b1ce-4fa50e226077 (uber "Sayed Kamal Sayed") = 'sayed kamal sayed'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 6616229 (bolt "Zubair Khan Shaukat Ali")
--   -> 67483c64055e070d791000e4 (hotel "ZUBAIR KHAN SHAUKAT ALI") = 'zubair khan shaukat ali'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08 over the contradiction of 2025-09-12
-- 5d1cd81e68944856a6274c458d5ee4f0 (yango "ZUBAIR KHAN")
--   -> 67483c64055e070d791000e4 (hotel "ZUBAIR KHAN SHAUKAT ALI") = 'zubair khan shaukat ali'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
-- 67483c64055e070d791000ef (hotel "ZUBAIR MUHAMMAD AFSAR MUHAMMAD")
--   -> 80353b2843844d6683b39450d0d458fa (yango "ZUBAIR MUHAMMAD AFSAR MUHAMMAD") = 'zubair muhammad afsar muhammad'
--   verified 2026-10-08 on a review ruling; ruled by the operator 2026-10-08
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

-- ── the views that depend on the column, and why they are the whole problem ──
-- Measured on production 2026-09-07, in the collector's own log:
--
--   ERROR [db] migration schema_v53.sql failed
--     {"err":"cannot drop column person_key of table trip because other objects
--             depend on it"}
--
-- sql/schema_v62.sql defines trip_ext as SELECT t.* over trip, so the view
-- depends on every column of it INCLUDING person_key, and a DROP COLUMN cannot
-- get past it. On a fresh database this file runs at position 53 and that view
-- is created at 62, so there is nothing to block it and the whole suite passes.
-- On a database that already exists — which is the only kind production has —
-- every view is already there and this file has been failing silently since the
-- day v62 shipped. The ledger does not record a failed file, so it retried
-- every boot, failed every boot, and the stored person_key went on carrying
-- whatever register was current when v62 landed while api/identity_map.js grew
-- to a hundred and thirty entries in front of it.
--
-- Dropping the views here and leaving them to a later file to recreate does NOT
-- work: the ledger skips a file whose sha it has already seen, so v62 would
-- never run again and trip_ext would simply be gone. And writing their
-- definitions out here would be a second copy of a view this codebase has
-- already been bitten by keeping two copies of.
--
-- So the definitions are read out of the catalogue, the views are dropped, the
-- columns are rebuilt, and the views are recreated from what was read. Nothing
-- is duplicated and nothing needs to know which views exist — a view added
-- tomorrow over any of these six columns is handled by the same code.

DO $mig$
DECLARE
  t   record;
  v   record;
  tpl text := $tpl$CASE driver_ext_id
         WHEN '7fc8da91fc4a44c185e8d6d918db3e6b' THEN 'aliyan khalil'
         WHEN 'ab2aec60-56ff-48e2-85c0-3591f6f29aa3' THEN 'moses arthur'
         WHEN '67483c64055e070d7910010a' THEN 'shehzad ahmad ghulam muhammad'
         WHEN '67483c64055e070d79100114' THEN 'sanaullah sher zamin'
         WHEN '6623821' THEN 'ali abbas ahmed'
         WHEN 'b17bcd50-e20b-4055-80d8-468131188397' THEN 'ali abbas ahmed'
         WHEN '67483c64055e070d791000cf' THEN 'soaieed alom ali'
         WHEN '6639200' THEN 'soaieed alom ali'
         WHEN '6780293' THEN 'fayed ali muhammad'
         WHEN '2a1d4e30-e10f-4f47-a610-faae8c94d125' THEN 'fayed ali muhammad'
         WHEN '69f7e655aab1412c83a9c6d4d58aa122' THEN 'tariq afzal'
         WHEN '7308211' THEN 'tariq afzal'
         WHEN '7523458' THEN 'hammad ahmad'
         WHEN '68766cd503051f14d95a81fb' THEN 'hammad ahmad'
         WHEN '9c09415b-9aa2-43dc-ac9e-298c3c72ac32' THEN 'amshid khan'
         WHEN '67483c64055e070d791000e5' THEN 'amshid khan'
         WHEN '6633456' THEN 'amshid khan'
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
         WHEN '1d910e38d0a5451ea5b4c45df2706c5e' THEN 'aamir khan amin'
         WHEN '48de0d9f0a7c493f83724bae1f8dd257' THEN 'abdul basit aman'
         WHEN '1427dd41041346988c05065cee86c47f' THEN 'abdul hannan momin humayoun habib momin'
         WHEN 'd5eb68b8397a449d82003ddf3faa52fa' THEN 'abdullah ahmad ullah khan'
         WHEN 'd6d4e1cb-296f-4ef5-8270-3653ef546a02' THEN 'abu bakar saddique kamil shah'
         WHEN 'd694b0919c1d4b639642771c0119509e' THEN 'ali rahman karim'
         WHEN 'd9b2de76-b535-4b23-a714-7e31724e50d2' THEN 'amir muhammad khan muhammad naeem khan'
         WHEN 'c7a289421a5848ee9bfacf71b133fc24' THEN 'amshid khan'
         WHEN 'ca4b038d57a146698bca6c1b1e0a999a' THEN 'arbab hassan rab nawaz'
         WHEN '6d1b7b15e277440cafcaf9a8e8983f8d' THEN 'atif shabir muhammad shabir'
         WHEN 'ed0cc768ec3d46f4b8932dfbf24f12f3' THEN 'bilal ahmad haji rehman'
         WHEN '3c0d36fd2caf48fbb45a10e8cf9aab1d' THEN 'danish rehman haji rehman'
         WHEN '449077790a0e4ac5a64585d4eb68eda1' THEN 'durga prasad basyal'
         WHEN '2948d032d7df4ad4827f611d296430c8' THEN 'hamza khan'
         WHEN 'd22a7087f9ac42119cbe936749cd0bf1' THEN 'ifraz ahmed ghulam ahmed'
         WHEN 'fa7219517bf24cefb719ec1b28e9a913' THEN 'mahaz ahmad darwaish khan'
         WHEN '735cc1574bfd46de8cfa7ed449d371f8' THEN 'mati ullah sharif khan'
         WHEN '9d77089bcf574517850372f447977d30' THEN 'mirza abdullah baig mirza zahid baig'
         WHEN '4688f7772f494801902447e10c6df649' THEN 'mohammad mokdassel md obaidullah'
         WHEN 'ffe3cfced8554932a6faf50538e944bf' THEN 'muhammad masood kishbar khan'
         WHEN 'e3cd308b2b5f48e19877b924b48bbb9d' THEN 'muhammad nadeem ajmal'
         WHEN '97d930a906e74d5d8d6fc25d75c2a128' THEN 'muhammad rahim muhammad saleem'
         WHEN '983dc9bfe04d4bd48729325ddaa42c0d' THEN 'muhammad shafiq raziq'
         WHEN '6589d771-fe78-4c9a-bc9d-686c39a91e4c' THEN 'muhammad zeeshan muhammad shahid'
         WHEN 'cfad6f03a439432e8fa6f9c8fe89edcb' THEN 'raja nouman ahmed'
         WHEN '3629dde64f684e2abdcc0aeb1487632a' THEN 'rakibul alam raihan md shofiqul alam'
         WHEN 'ebe0dcf0-c554-4320-9f36-e61c17713d8d' THEN 'rashid ali haji hussain'
         WHEN '67352587e6664d86b723b25eb7dbd89e' THEN 'rizwan ullah muzamil khan'
         WHEN 'ba329c7a6ac34245acf074c3250bc555' THEN 'roy vellespen ocdol'
         WHEN '13f61bb13eae43c3b0cf5d4af1c736d8' THEN 'sajid ayaz ahmed'
         WHEN '36b941b820be498c907628b253adb32b' THEN 'sameh talaat abdelmaksoud abdelsamie'
         WHEN 'f7d8a0ff324641b1bc96c649290da826' THEN 'sikandar tariq hussain'
         WHEN 'cf3a1777da6f49bb814d7cd3ec8f92fd' THEN 'sumon ahmed khan nizam uddin khan'
         WHEN 'cac5cfedf0df4f90a0086cefc297d535' THEN 'umar kayani nasir waheed kayani'
         WHEN '563467d09d3d4f629b8b65e9c67d591f' THEN 'umer naveed abdul qadir'
         WHEN '5d42345bcf4440df93645a54aedb9bc6' THEN 'wajid akbar khan'
         WHEN 'b14f2b04795c411b8c01b2edc2a37774' THEN 'zain ali ghulam hassnain'
         WHEN '67483c64055e070d791000f5' THEN 'wisal muhammad'
         WHEN '122e8a0195354a0090474be38680ca2c' THEN 'wisal muhammad'
         WHEN '6628822' THEN 'muhammad khalifa afzal khalid'
         WHEN 'dc2705246ec84c17921d272b0aaf73d3' THEN 'muhammad khalifa afzal khalid'
         WHEN '6842136' THEN 'zeeshan ahmad ur rahman'
         WHEN '4517ca6e-8b79-4bd4-8e4d-88c86d5dd6b9' THEN 'zeeshan ahmad ur rahman'
         WHEN '6615331' THEN 'muhammad talha faizullah'
         WHEN '467b94c54718457da9f3d434d3a5390c' THEN 'muhammad talha faizullah'
         WHEN '67483c64055e070d79100126' THEN 'muhammad talha faizullah'
         WHEN '6639159' THEN 'fawad ali khan ayaz muhammad'
         WHEN 'b4a7efd8-2808-4058-8595-635918c6bcf2' THEN 'umer naveed abdul qadir'
         WHEN '6611555' THEN 'umer naveed abdul qadir'
         WHEN '680790c003051f14d956b356' THEN 'ali abbas ahmed'
         WHEN '6640364' THEN 'muhammad asif zada'
         WHEN '9407cd209754464885335d800596c5ae' THEN 'muhammad asif zada'
         WHEN '67483c64055e070d7910010b' THEN 'muhammad asif zada'
         WHEN '6616065' THEN 'mahaz ahmad darwaish khan'
         WHEN '67483c64055e070d791000e1' THEN 'mahaz ahmad darwaish khan'
         WHEN '6901260' THEN 'wajid ali ameer bakhsh'
         WHEN 'ffe30d6937114c1282457ed38010d274' THEN 'wajid ali ameer bakhsh'
         WHEN '67483c64055e070d791000dc' THEN 'wajid ali ameer bakhsh'
         WHEN '6628151' THEN 'aamir khan amin'
         WHEN '67483c64055e070d7910011e' THEN 'aamir khan amin'
         WHEN '005211c6d1204ab89ffe0ed358cfa91a' THEN 'najeeb ullah khan'
         WHEN '69b7cb84cc90e854f1e4ff16' THEN 'najeeb ullah khan'
         WHEN '6640532' THEN 'zia ali said muhammad'
         WHEN '6611346' THEN 'abdul basit ayaz ahmed'
         WHEN '02cec98f-25ae-4cb9-9fd5-671920f958ac' THEN 'abdul basit ayaz ahmed'
         WHEN '7779693' THEN 'siyad kallyanathoppil paramba'
         WHEN '6d175dd8-8d9c-4c88-8399-5b5c8a5efb85' THEN 'siyad kallyanathoppil paramba'
         WHEN '90f893d3-7595-4743-8efe-62b2815677b7' THEN 'hussain ansar'
         WHEN '7624035' THEN 'hussain ansar'
         WHEN '58de23fbd6e14a4389b7557c732ee607' THEN 'hussain ansar'
         WHEN '6628504' THEN 'mohammed alsoos'
         WHEN '518aacd8fd9347bca83baef90671cb77' THEN 'mohammed alsoos'
         WHEN '6598737' THEN 'abass tanko'
         WHEN '41a6094035854fa49079fd38fff276ec' THEN 'abass tanko'
         WHEN '67483c64055e070d7910011c' THEN 'abass tanko'
         WHEN 'fb09dfee-cf6d-4391-8b57-e45e0e9ec743' THEN 'zain ali ghulam hassnain'
         WHEN '6633916' THEN 'zain ali ghulam hassnain'
         WHEN '6611368' THEN 'asif mehmood abdul qadeer'
         WHEN 'd7cf380a-7777-431f-ac84-78afe493988d' THEN 'asif mehmood abdul qadeer'
         WHEN '7399815' THEN 'abu bakar saddique kamil shah'
         WHEN '7644369' THEN 'sajid gul muhammad'
         WHEN '072492179a9c45e9b2aa438122615687' THEN 'sajid gul muhammad'
         WHEN '7208744' THEN 'abidullah safi'
         WHEN '60e3d6c96fd44a5599ba7d326db30f47' THEN 'abidullah safi'
         WHEN '691d9b128c482942eaad6aa7' THEN 'muhammad toussef bangash'
         WHEN '6628167' THEN 'roy vellespen ocdol'
         WHEN '67483c64055e070d79100100' THEN 'roy vellespen ocdol'
         WHEN '6611263' THEN 'mohd shohidul islam shamsul alam'
         WHEN 'c366fc8a-a007-461a-b06d-256d9c411c85' THEN 'mohd shohidul islam shamsul alam'
         WHEN '4f54b70d5fd54aad8554f8c33ed20d8b' THEN 'hammad ahmad'
         WHEN '6610879' THEN 'mummer inam ullah'
         WHEN '4a315dee-2a2d-45b2-b2a1-cda45828ed6e' THEN 'mummer inam ullah'
         WHEN 'c74f4bf5fe2f45bfbd3c42a68857f3f0' THEN 'zahid khan'
         WHEN '3343a680ce234548998464bfd7784cb3' THEN 'zahid khan'
         WHEN '6611186' THEN 'mohammed fazlul siddik'
         WHEN '0876b449-12ca-45dd-8f44-262b901a4772' THEN 'mohammed fazlul siddik'
         WHEN '6818383' THEN 'mohamed essam abdelfattah'
         WHEN '208a7776-fc88-4604-ab49-631437b77dd5' THEN 'mohamed essam abdelfattah'
         WHEN '33cce538-9975-4d96-b770-df1178d2ad5c' THEN 'mati ullah sharif khan'
         WHEN '6781253' THEN 'mati ullah sharif khan'
         WHEN '7841834' THEN 'wahab ali zada'
         WHEN '6a4f4253b3b4e99c0391a15e' THEN 'wahab ali zada'
         WHEN '72191eb6-9500-4974-a4cc-b8211333e809' THEN 'wahab ali zada'
         WHEN '6628149' THEN 'harish kumar chand'
         WHEN '688a1c98a0bf23d354fda5a7' THEN 'harish kumar chand'
         WHEN '6623707' THEN 'ali nawaz muhammad nawaz'
         WHEN '10e01fb59b184ab88dc750704a9bc10e' THEN 'ali nawaz muhammad nawaz'
         WHEN '7838158' THEN 'hamza iqbal sajid iqbal'
         WHEN '68b94a08b0dc20d631c56a68' THEN 'hamza iqbal sajid iqbal'
         WHEN '48cfb2ac-0ddc-4742-96ed-6b1d2a09c491' THEN 'hamza iqbal sajid iqbal'
         WHEN '6ac3a5d36e0dbece4b47dd5d' THEN 'muhammad nazir khan'
         WHEN '6620288' THEN 'muhammad sameer shamrez asghar'
         WHEN '9b9d8a53b6ea47f5a5b0e5e4ddca9d1f' THEN 'muhammad sameer shamrez asghar'
         WHEN '6997345' THEN 'muhammad shahab abbasi'
         WHEN '02578759-f32e-41c7-a096-51ebe1c046aa' THEN 'muhammad shahab abbasi'
         WHEN '67483c64055e070d791000ff' THEN 'muhammad shahab abbasi'
         WHEN '7501194' THEN 'ullal abdul rasheed kotepura'
         WHEN '68821890a0bf23d354fd700d' THEN 'ullal abdul rasheed kotepura'
         WHEN '1fc71474-5345-46e9-b7d9-3f5a38bbdbf0' THEN 'ullal abdul rasheed kotepura'
         WHEN '6620158' THEN 'kashif ali ayyub khan'
         WHEN 'a411e6c0e37c42f4869f4b230fc78292' THEN 'kashif ali ayyub khan'
         WHEN '6d707fcd-fe3d-43f3-b0b9-778c798cacd0' THEN 'arbab hassan rab nawaz'
         WHEN '7605526' THEN 'arbab hassan rab nawaz'
         WHEN '6623598' THEN 'faisal badshah rasool badshah'
         WHEN 'd43113c2f35f4d7ea618c70845c85247' THEN 'faisal badshah rasool badshah'
         WHEN '7727920' THEN 'waqas riaz'
         WHEN 'a604d59c88e94a758ce9a19264fec2dc' THEN 'waqas riaz'
         WHEN '7726833' THEN 'aftab ahmed muhammad sharif altaf'
         WHEN '8181338' THEN 'farman ullah ghafoor khan'
         WHEN 'f6c68bff-3b30-436b-9481-ee0fa4da9958' THEN 'renato romillano yap'
         WHEN '7976866' THEN 'joseph wandera'
         WHEN '6611279' THEN 'ahmed mohamed gadalla'
         WHEN '60003270-6e09-495b-b801-bbf4c6b7aa53' THEN 'ahmed mohamed gadalla'
         WHEN '8219954' THEN 'alakbar rahimov'
         WHEN '7b1408ba9a154514b1d2c6182eaf2d75' THEN 'alakbar rahimov'
         WHEN '8175513' THEN 'muhammad yaseen saeed ur rahman'
         WHEN '8185992' THEN 'waseem abbas ghulam nabi'
         WHEN '82b0abaeab4c4ee3b95fa8094978ca9a' THEN 'waseem abbas ghulam nabi'
         WHEN '6640352' THEN 'umair ahmad gul'
         WHEN '67483c64055e070d791000eb' THEN 'umair ahmad gul'
         WHEN 'b3edf09c58f542e98ff5bd1068d178e8' THEN 'umair ahmad gul'
         WHEN '8074837' THEN 'sikandar tariq hussain'
         WHEN '7624077' THEN 'rashid khan muhammad'
         WHEN '6a37fe4f-8f44-4af0-a043-5cc3e1ffdcb1' THEN 'mohammad mokdassel md obaidullah'
         WHEN '6628253' THEN 'mohammad mokdassel md obaidullah'
         WHEN '6628607' THEN 'abdul malik muhammad iqbal'
         WHEN '67483c64055e070d791000d6' THEN 'abdul malik muhammad iqbal'
         WHEN '7003039' THEN 'henok melese amdisa'
         WHEN '8b20b014-d999-41cf-965f-c10363175d5e' THEN 'henok melese amdisa'
         WHEN '7643624' THEN 'muhammad hanan munir muhammad munir'
         WHEN 'bdc98198249e4b6698131d2b5667bcd7' THEN 'muhammad hanan munir muhammad munir'
         WHEN '6623922' THEN 'muhammad shafiq raziq'
         WHEN '67483c64055e070d791000e9' THEN 'muhammad shafiq raziq'
         WHEN '6a8dac427ba7dbf44436ca89' THEN 'bashir ahmad amin'
         WHEN '7238992' THEN 'dawit zeraye haile'
         WHEN 'd10ed574-6f79-4f07-990a-5ec7f91a2df4' THEN 'dawit zeraye haile'
         WHEN 'bb4b1157-37e9-443c-82ef-1fb33660e9ad' THEN 'ifraz ahmed ghulam ahmed'
         WHEN '7523359' THEN 'ifraz ahmed ghulam ahmed'
         WHEN '8120259' THEN 'henry martin motha'
         WHEN '6904614c8c482942eaac6e48' THEN 'henry martin motha'
         WHEN '48a7ee6e-f6d7-4491-a811-798263d4616f' THEN 'henry martin motha'
         WHEN '8636581' THEN 'muhammad naqeeb gull'
         WHEN '67731662-84af-4378-a00d-664845eaee9a' THEN 'muhammad naqeeb gull'
         WHEN '7874177' THEN 'amir muhammad khan muhammad naeem khan'
         WHEN '6628730' THEN 'mateen gul'
         WHEN '352cdd896af14ffca96d2fb943c99ad0' THEN 'mateen gul'
         WHEN 'fd30bb7f-8964-4195-8e94-125ae117772f' THEN 'sajid ayaz ahmed'
         WHEN '6610666' THEN 'sajid ayaz ahmed'
         WHEN '6628224' THEN 'kashan malik abdul malik'
         WHEN 'f4a294bd4b48456496921e542e58e79e' THEN 'kashan malik abdul malik'
         WHEN '7976847' THEN 'moses bale'
         WHEN '16b7df80-d744-4dc4-87d2-7a7d588d849e' THEN 'mirza abdullah baig mirza zahid baig'
         WHEN '6628129' THEN 'mirza abdullah baig mirza zahid baig'
         WHEN '6611073' THEN 'zeeshan nadeem akram'
         WHEN '67483c64055e070d79100132' THEN 'zeeshan nadeem akram'
         WHEN '6e53bb51-d55e-4370-b855-10cb8025b936' THEN 'bilal ahmad haji rehman'
         WHEN '6628147' THEN 'bilal ahmad haji rehman'
         WHEN '7cf929d6-45fa-4b87-ac1f-4469ef103358' THEN 'muhammad rahim muhammad saleem'
         WHEN '6628824' THEN 'muhammad rahim muhammad saleem'
         WHEN '567a259c-9610-4fea-9704-7e9bfd8397ad' THEN 'andreh elias aoun'
         WHEN '6939735' THEN 'wajid rehman nausherwan'
         WHEN '67483c64055e070d791000fb' THEN 'wajid rehman nausherwan'
         WHEN '9048361' THEN 'chahat ravinder'
         WHEN 'c9943fab-aca7-42c3-a7b6-bb91a298f1b3' THEN 'chahat ravinder'
         WHEN '8143925' THEN 'hassan talaat kamel abousira'
         WHEN '6634999' THEN 'midrar khan'
         WHEN '67483c64055e070d7910011a' THEN 'midrar khan'
         WHEN '6611356' THEN 'hasan wadie alabaza'
         WHEN 'f9aa707b-6b85-460c-91c5-b88df7808758' THEN 'hasan wadie alabaza'
         WHEN '6663860' THEN 'zahid ullah afsar zada'
         WHEN '67483c64055e070d79100127' THEN 'zahid ullah afsar zada'
         WHEN '6a242abc-ea2e-4a67-8d70-ce4644875dd5' THEN 'danish rehman haji rehman'
         WHEN '6623840' THEN 'danish rehman haji rehman'
         WHEN '6615750' THEN 'mohammad naeem adam khan'
         WHEN '8108061' THEN 'chingiz seftarov'
         WHEN '4ca00da1-292a-464e-82c5-f7702b135331' THEN 'chingiz seftarov'
         WHEN '41dd8378ea3a4998a7a1ad70cf1656ba' THEN 'muhammad ishtiaq khan'
         WHEN '7569135' THEN 'aman ullah amir mehboob alam'
         WHEN '6610828' THEN 'abdul hannan momin'
         WHEN '6901251' THEN 'jawad khan gohar'
         WHEN '68766b8003051f14d95a81dc' THEN 'jawad khan gohar'
         WHEN '6610637' THEN 'zain ul abideen muhammad irfan'
         WHEN '6997157' THEN 'muhammad faraz khan'
         WHEN '35067d2a-3f1e-402e-97f3-fc87657c8153' THEN 'muhammad faraz khan'
         WHEN '6610628' THEN 'kazi fuad ahmed kazi alim ullah'
         WHEN 'a9634a34f151436da7669fda9cc58bbc' THEN 'kazi fuad ahmed kazi alim ullah'
         WHEN '6633745' THEN 'muhammad ihtisham zaman'
         WHEN '67483c64055e070d7910012b' THEN 'muhammad ihtisham zaman'
         WHEN '6611196' THEN 'arivoli rajendran'
         WHEN 'fb82dc91-90f6-4f1b-9793-b97ccea96640' THEN 'arivoli rajendran'
         WHEN '7636498' THEN 'muhammad talha qureshi'
         WHEN '688218d1a0bf23d354fd7014' THEN 'muhammad talha qureshi'
         WHEN '812895dc-41b5-4c11-bcb4-fdfdc308c73e' THEN 'muhammad talha qureshi'
         WHEN '6907719' THEN 'saad ali akram muhammad akram bhatti'
         WHEN 'dd4a45c2d6f3449da9807d81558ecbd2' THEN 'saad ali akram muhammad akram bhatti'
         WHEN '8168176' THEN 'abdul basit aman'
         WHEN '6814489' THEN 'irfan ullah awal ameen'
         WHEN 'f7aad3d6075f4e788a303ce744d9986c' THEN 'irfan ullah awal ameen'
         WHEN '6610644' THEN 'khalid abdalrahman albadwi'
         WHEN '67483c64055e070d791000c7' THEN 'khalid abdalrahman albadwi'
         WHEN '6600403' THEN 'muhammad rahim rauf'
         WHEN '4ea45e6f-f67f-4484-b5cf-f254e618eeab' THEN 'muhammad rahim rauf'
         WHEN '9048366' THEN 'edwin nyasani mandere'
         WHEN '7874167' THEN 'muhammad zeeshan muhammad shahid'
         WHEN '6a4e97abb3b4e99c0391914e' THEN 'muhammad zeeshan muhammad shahid'
         WHEN '6785544' THEN 'wajahat khan'
         WHEN 'a206c164ad194fe385209d40a17e5246' THEN 'wajahat khan'
         WHEN '67483c64055e070d791000e6' THEN 'wajahat khan'
         WHEN '8110251' THEN 'abusaad siddiqui akhlaque ahmad'
         WHEN 'd6892f17ac534650b6855ffa3161f6bb' THEN 'abusaad siddiqui akhlaque ahmad'
         WHEN '7202128' THEN 'ali raza shah'
         WHEN '0cb17332-9d08-4d1e-8806-898ad47d784d' THEN 'ali raza shah'
         WHEN '9131685' THEN 'norah chia nsom'
         WHEN '6aa01aee0b289436de6ec0d2' THEN 'muhammad sheraz muhammad'
         WHEN '6864801' THEN 'muhammad ali bajwa'
         WHEN '6623648' THEN 'zahid ezazullah'
         WHEN '6623561' THEN 'atif shabbir'
         WHEN '6934090' THEN 'maqsood muhabat shah'
         WHEN '7416662' THEN 'mansoor mohammad naeem'
         WHEN 'ba2f3489-1277-4a64-9671-f800173b0aae' THEN 'mansoor mohammad naeem'
         WHEN '9324842' THEN 'muhammad ahmad ghulam qadir'
         WHEN '7523326' THEN 'cedric wendkuni kabore'
         WHEN '68766c9e03051f14d95a81f4' THEN 'cedric wendkuni kabore'
         WHEN 'c9948e92-9d32-40bb-91ec-1b3d124647f9' THEN 'muhammad masood kishbar khan'
         WHEN '6628159' THEN 'muhammad masood kishbar khan'
         WHEN '6640621' THEN 'muhammad amir misree khan'
         WHEN '8203414' THEN 'rashid ali haji hussain'
         WHEN '8410975' THEN 'sar zamin khan shah bahadar'
         WHEN '8fb45c4e-a2ab-413b-9069-355902279de9' THEN 'sameh talaat abdelmaksoud abdelsamie'
         WHEN '6628152' THEN 'sameh talaat abdelmaksoud abdelsamie'
         WHEN '9492548' THEN 'saddam hussain islam'
         WHEN '494e1f9c-909d-453e-8588-8c12b4c0ddcc' THEN 'saddam hussain islam'
         WHEN '6628537' THEN 'zia ullah nasrullah khan'
         WHEN '805583c3bc6e450aa33ad320e991e714' THEN 'zia ullah nasrullah khan'
         WHEN '67483c64055e070d79100108' THEN 'zia ullah nasrullah khan'
         WHEN '7300699' THEN 'muhammad hasham tanveer ahmad khan'
         WHEN 'fa1379f659d343409a1807a4e0e2e1fd' THEN 'sabbir hossain shahalom'
         WHEN '6880673' THEN 'hassan munawar shaad'
         WHEN 'f157aac8-ff4d-489d-9d35-1d96ffc5e4ca' THEN 'hassan munawar shaad'
         WHEN '67483c64055e070d79100124' THEN 'imad khan darwish khan'
         WHEN '9081508' THEN 'zain hassan raja nasrullah khan'
         WHEN '36f2a997f1ef434fa3fbd2d63d945c05' THEN 'zain hassan raja nasrullah khan'
         WHEN '0a688852-8cbb-4661-ae26-a2a0057b2690' THEN 'rizwan ullah muzamil khan'
         WHEN '6623653' THEN 'rizwan ullah muzamil khan'
         WHEN '6901485' THEN 'abdelmohsen said ghanem'
         WHEN '785f350f-47d2-4b3a-99a5-923f01d8f7c9' THEN 'abdelmohsen said ghanem'
         WHEN '9481149' THEN 'wunibie mohammed issah'
         WHEN '76f1b791-52ad-4c1a-899c-c2b9c2d8db36' THEN 'wunibie mohammed issah'
         WHEN '6835351' THEN 'ubaid ullah hassan muhammad'
         WHEN '67483c64055e070d791000ce' THEN 'ubaid ullah hassan muhammad'
         WHEN '9503883' THEN 'sebastian jerones'
         WHEN 'a4da2085550d423f9c20d374473e474f' THEN 'majid shah mehboob shah'
         WHEN '8348168' THEN 'nizam wazir zada'
         WHEN '693a7cea8c482942eaaec601' THEN 'nizam wazir zada'
         WHEN '6cf65aa1-b9b6-4efc-b006-a0a4bde7a2f4' THEN 'muhammad hussnain muhammad rafique'
         WHEN '6628172' THEN 'muhammad aqib khan'
         WHEN '6623720' THEN 'muhammed shahab khan'
         WHEN '688b20bea0bf23d354fdbaca' THEN 'muhammed shahab khan'
         WHEN '7714111' THEN 'abas osman abyan'
         WHEN 'bb9ef8895f9e4e5c8947258ef0ae1503' THEN 'abas osman abyan'
         WHEN '6800964' THEN 'sheraz rehman khan'
         WHEN 'cbc987fdf3164305b62700b707905664' THEN 'sameh altabei elsayed mohamed'
         WHEN '6611334' THEN 'abdul salim aziz abdul gaffur'
         WHEN '92a8c1c8-f5ab-462a-99a3-165dc3fbe6c2' THEN 'abdul salim aziz abdul gaffur'
         WHEN '8035834' THEN 'muhammad haris bangash'
         WHEN '87a43a33-2869-44ba-94d5-c9109c308daa' THEN 'muhammad haris bangash'
         WHEN '6611221' THEN 'durga prasad basyal'
         WHEN '4abd6016-c582-44f9-8bf7-6af054d0cbe6' THEN 'durga prasad basyal'
         WHEN '6628957' THEN 'umar ali zarid khan'
         WHEN '7859266' THEN 'umar ali zarid khan'
         WHEN '23a584f3-cfc7-450e-bb42-6a71ebf0d613' THEN 'abdullah ahmad ullah khan'
         WHEN '6628743' THEN 'abdullah ahmad ullah khan'
         WHEN '8170855' THEN 'elchin goyushov'
         WHEN 'a4fb427a-514a-476f-9e5f-6498367f327e' THEN 'elchin goyushov'
         WHEN '67483c64055e070d79100121' THEN 'zahid khan ismail'
         WHEN '9593727' THEN 'dev bahadur gurung'
         WHEN '93378ac8-6756-439c-9c92-e298ece77c33' THEN 'dev bahadur gurung'
         WHEN '6659711' THEN 'noorullah khan zaman'
         WHEN '67483c64055e070d79100102' THEN 'noorullah khan zaman'
         WHEN '8074227' THEN 'muhammad nadeem ajmal'
         WHEN '6623712' THEN 'ansar murtaza butt rashid murtaza'
         WHEN 'e2e561163b1b40aaa79b82a87be40f6b' THEN 'ansar murtaza butt rashid murtaza'
         WHEN '6c861462-33fa-4da4-9ef6-5d0f8d372633' THEN 'haider ali khalid mahmood'
         WHEN '67483c64055e070d7910010c' THEN 'haider ali khalid mahmood'
         WHEN '6a042a98284c6a4354627f36' THEN 'moidutty sanafu moidutty'
         WHEN '7158151' THEN 'wajid akbar khan'
         WHEN '221b1276-c0de-43ef-973c-0e536460337d' THEN 'faizan waris muhammad waris'
         WHEN '5edfb1b3-25a5-42f7-9759-4f3e4f22c4d6' THEN 'leon anthony marcus'
         WHEN '8274586' THEN 'muhammad rashid riasat'
         WHEN 'e125d722-cd21-4636-a38c-b2c54494c89f' THEN 'muhammad rashid riasat'
         WHEN '6639693' THEN 'muhammad abid ali khan noor'
         WHEN '6620175' THEN 'nosher hassan bhatti'
         WHEN '8519700' THEN 'fahad mustafa'
         WHEN '11ebc40b-25cf-47db-91a3-8705c70ee4ef' THEN 'fahad mustafa'
         WHEN '9674928' THEN 'javeed ahmed abuthahir'
         WHEN '6ac5f35a6e0dbece4b48591e' THEN 'javeed ahmed abuthahir'
         WHEN '7194959' THEN 'muhammad sabir jamal'
         WHEN 'bfb35d1b-be59-4abe-9d35-41870fcd1863' THEN 'muhammad sabir jamal'
         WHEN 'cf47057f-57d4-480c-b581-23edc94a542a' THEN 'maimaitiyiming abuduhaibaier'
         WHEN 'b4f0558b-284b-4d91-b40a-5ed7b8c11c67' THEN 'dhavooth ibrahim abdul kadhar'
         WHEN '6940023' THEN 'umairuddin mohammed zameeruddin'
         WHEN '2df8f636-2964-4163-a164-b09154f92c80' THEN 'umairuddin mohammed zameeruddin'
         WHEN '8051700' THEN 'mohammad asif ahmad'
         WHEN '90c2e390-2820-4d26-8cf3-2b84ca717c55' THEN 'mohammad asif ahmad'
         WHEN '6a291640284c6a4354651585' THEN 'shahid khan zada'
         WHEN '7312220' THEN 'muhammad nasir khan'
         WHEN 'b5c7ce92-b5fd-4e08-bc9b-09bcc37f1ac3' THEN 'muhammad nasir khan'
         WHEN '7547689' THEN 'arslan arif'
         WHEN '92ec45d804f34718a8ed6214cfb99b4d' THEN 'arslan arif'
         WHEN '8033691' THEN 'muhammad usman khan'
         WHEN '3d226bd8-47bf-4d9e-b4d2-722756144ee9' THEN 'muhammad usman khan'
         WHEN '7416327' THEN 'younas khan shah'
         WHEN '9642366' THEN 'muhammad asim shahzad'
         WHEN '6f564b8c1a334a7eb9953614300d8e85' THEN 'yousaf ali javed iqbal khan'
         WHEN '7294843' THEN 'hassan elsayed hassan'
         WHEN '83cf7ce5-764e-4588-994f-d415566288c1' THEN 'hassan elsayed hassan'
         WHEN '413c9c74-c8dc-402e-98dd-7317c9855d33' THEN 'emad alabdon'
         WHEN '7643640' THEN 'mohammed musab rahmathulla'
         WHEN '2bde54e1ec3d46e787c3562a15459a16' THEN 'mohammed musab rahmathulla'
         WHEN '0f314ca4-fedd-4de5-9b48-59f274776381' THEN 'shajahan mk'
         WHEN '00c0221c4aec47db9813f6c525167561' THEN 'maen m alaa shekfa'
         WHEN '6628845' THEN 'maen m alaa shekfa'
         WHEN 'd43a09f3ab8a44b5ab6d35331edb59af' THEN 'farhan khan manazir khan'
         WHEN '8af4f8d8-c28b-4eef-be5b-609947c9567c' THEN 'moidutty sanafu cherunambi moidutty'
         WHEN '6628548' THEN 'umar kayani nasir waheed kayani'
         WHEN '8555822' THEN 'alzain alfatih ahmed'
         WHEN '2b53af79-175b-4ff4-bd2e-545c2d409ce9' THEN 'alzain alfatih ahmed'
         WHEN '4e75cfb248fc45dd8bc41c460e956bfb' THEN 'shehzad ahmad ghulam muhammad'
         WHEN 'b826dc16c41248b1a5005750d255231b' THEN 'shehzad ahmad ghulam muhammad'
         WHEN '8519699' THEN 'khan akbar khan'
         WHEN '1f1bb8d4-9a08-41ae-b376-0135ca67a431' THEN 'khan akbar khan'
         WHEN '34e629f1fab64e9a814089dc0d2a086d' THEN 'rufat gadirli'
         WHEN '808537b4-e268-4c3c-bac1-fc1cf6c74004' THEN 'binu abdul rehman kunju abdul rahman kunju'
         WHEN '6628589' THEN 'nauman hassan shida muhammad'
         WHEN '72caf703fcf64d63965b80a6497428ac' THEN 'nauman hassan shida muhammad'
         WHEN '6616332' THEN 'sayed kamal sayed'
         WHEN '67483c64055e070d791000fa' THEN 'sayed kamal sayed'
         WHEN '36aace666f914d8db5d3e5be3bb6f7fd' THEN 'sayed kamal sayed'
         WHEN '6616229' THEN 'zubair khan shaukat ali'
         WHEN '5d1cd81e68944856a6274c458d5ee4f0' THEN 'zubair khan shaukat ali'
         WHEN '67483c64055e070d791000ef' THEN 'zubair muhammad afsar muhammad'
         ELSE regexp_replace(
             btrim(regexp_replace(lower(%I), '\s+', ' ', 'g')),
             '(\m\w+)( \1)+', '\1', 'g') END$tpl$;
  need boolean := false;
  saved text[] := '{}';
  stmt text;
BEGIN
  /* Nothing is dropped unless something actually needs rebuilding. A boot on a
     database already carrying this register must not drop and recreate eight
     views for nothing. */
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
         AND c.generation_expression LIKE '%67483c64055e070d791000ef%'
         -- …and carries as many merges as this register has, so a column built
         -- from a SUPERSET that happens to end on the same pair still rebuilds.
         AND (length(c.generation_expression)
              - length(replace(c.generation_expression, 'WHEN ', ''))) / 5 = 504);
    need := true;
  END LOOP;
  IF NOT need THEN RETURN; END IF;

  /* ── read the dependent views out of the catalogue ──────────────────────
     Every view built on any of these six person_key columns, and every view
     built on THOSE, since a view over a view blocks the drop just as firmly.
     The depth column orders them so a view is recreated after whatever it
     selects from.
     Capped at ten levels: a cycle is impossible in Postgres's view graph, and
     a runaway loop inside a migration is worse than a missing view. */
  FOR v IN
    WITH RECURSIVE dep AS (
      SELECT DISTINCT r.ev_class AS oid, 1 AS depth
        FROM pg_depend d
        JOIN pg_rewrite r  ON r.oid = d.objid
        JOIN pg_class  src ON src.oid = d.refobjid
        JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = d.refobjsubid
       WHERE a.attname = 'person_key'
         AND src.relname IN ('trip', 'driver_platform_state', 'vehicle_driver_day',
                             'money_event', 'driver_statement_day', 'driver_payout_day')
      UNION ALL
      SELECT r.ev_class, dep.depth + 1
        FROM dep
        JOIN pg_depend d  ON d.refobjid = dep.oid
        JOIN pg_rewrite r ON r.oid = d.objid AND r.ev_class <> dep.oid
       WHERE dep.depth < 10
    )
    SELECT c.relname AS name, max(dep.depth) AS depth,
           pg_get_viewdef(c.oid) AS def
      FROM dep JOIN pg_class c ON c.oid = dep.oid
     WHERE c.relkind = 'v'
     GROUP BY c.relname, c.oid
     ORDER BY 2, 1
  LOOP
    saved := saved || format('CREATE VIEW %I AS %s', v.name, v.def);
    RAISE NOTICE 'person_key rebuild: saving view %', v.name;
  END LOOP;

  /* Dropped deepest-first, though CASCADE would handle the order — every one
     of them is in the saved array, so nothing CASCADE takes goes unrecreated. */
  FOR v IN SELECT unnest AS name FROM unnest(ARRAY(
      SELECT c.relname FROM pg_class c
       WHERE c.relkind = 'v' AND c.relnamespace = current_schema()::regnamespace
         AND format('CREATE VIEW %I AS %s', c.relname, pg_get_viewdef(c.oid)) = ANY(saved)))
  LOOP
    EXECUTE format('DROP VIEW IF EXISTS %I CASCADE', v.name);
  END LOOP;

  /* ── the rebuild itself ─────────────────────────────────────────────── */
  FOR t IN SELECT * FROM (VALUES
        ('trip',                 'driver_name'),
        ('driver_platform_state','full_name'),
        ('vehicle_driver_day',   'driver_name'),
        ('money_event',          'driver_name'),
        ('driver_statement_day', 'driver_name'),
        ('driver_payout_day',    'driver_name')
      ) v(tbl, namecol)
  LOOP
    CONTINUE WHEN to_regclass(t.tbl) IS NULL;
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS person_key', t.tbl);
    EXECUTE format('ALTER TABLE %I ADD COLUMN person_key text GENERATED ALWAYS AS (%s) STORED',
                   t.tbl, format(tpl, t.namecol));
  END LOOP;

  /* ── and put the views back, shallowest first ───────────────────────── */
  FOREACH stmt IN ARRAY saved LOOP
    EXECUTE stmt;
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

-- ── and then tell the planner what it is looking at ───────────────────────
-- Re-adding a generated column rewrites the whole table, and a rewritten table
-- arrives with no statistics at all: no row estimate, no n_distinct for
-- person_key, no correlation. Postgres does not sample it on the spot, it
-- waits for autovacuum, and on a basic-xxs instance that wait is long.
--
-- Measured on production 2026-09-07, the boot this file first applied:
-- /api/kpis over the full window went from roughly a second to 48, on
-- unchanged query text and unchanged data. Every plan over person_key was
-- being costed against a table the planner believed was empty.
--
-- ANALYZE is cheap next to the rewrite that precedes it (single-digit seconds
-- against two minutes), it is legal inside the implicit transaction this file
-- runs in — unlike VACUUM, which is not, and which autovacuum will do in its
-- own time — and it runs even on the cheap path where the guard above skipped
-- the rebuild, which costs one sample and keeps a re-run honest.
ANALYZE trip;
ANALYZE driver_platform_state;
ANALYZE vehicle_driver_day;
ANALYZE money_event;
ANALYZE driver_statement_day;
ANALYZE driver_payout_day;
