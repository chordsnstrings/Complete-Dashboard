-- v102 — the people the operator ruled one person on 2026-10-08, made one
-- person row each where ledger money had kept them on two.
--
-- ── WHY THE REGISTER ALONE DOES NOT FINISH THE JOB ──────────────────────
-- The operator went through the duplicates on 2026-10-08 ("there are still
-- drivers who are the same drivers working on different platforms but counted
-- as two") and ruled 192 people one person each: 184 already joined on the
-- Drivers page by a confirmed link, the strong and weak look-alike pairs, the
-- no-trip records standing on the other man's car, and the four pairs PENDING
-- held. api/identity_map.js now carries every one of them, and
-- sql/schema_v53.sql is regenerated from it, so every rollup keyed on
-- person_key — Target, Month target, the 08:00 email, payouts, statements —
-- counts each as one.
--
-- The Drivers page, the driver page, the ledger and the texts group by the
-- PERSON SPINE instead (driver + driver_platform_id, src/persons.js). The
-- spine sees one component once the register joins two records, but it folds
-- two person rows ONLY while neither carries money: re-pointing a balance is
-- "an operation somebody authorises and records". Measured on production the
-- morning of the review, before this shipped: 35 of the ruled people still
-- sat on two Drivers-page rows, and the spine would leave most of them there,
-- because nearly every person row on this fleet carries a ledger entry.
--
-- The operator's ruling IS the authorisation — sql/schema_v93.sql set that
-- precedent for Ali Abbas Ahmed on 2026-09-29 — and this file is that recorded
-- merge, made once per person, by the same statements v93 and
-- api/person_merge_routes.js run.
--
-- ── WHAT MOVES, PER PERSON ───────────────────────────────────────────────
-- The survivor is the person row holding the register's `keep` account, or,
-- where that account has no row yet (a no-trip record), the lowest person row
-- holding any of the person's accounts. Every OTHER person row holding one of
-- the person's accounts folds into it, exactly as v93:
--   driver_ledger.person_id, driver_platform_id.driver_id (detached rows too),
--   driver_ledger_audit.person_id, sms_outbox.person_id, and driver.cash_rule
--   where the survivor has none. acct_platform/acct_ext_id and person_name on
--   each entry do not move: they are evidence of what was recorded.
-- One audit row per folded person row lists every entry id with its amount,
-- every account, every audit and SMS row moved — undone by reading that row.
--
-- ── WHEN A PERSON IS REFUSED, AND WHY THAT IS NOT A FAILURE ─────────────
--   · AN OPENING ON BOTH ROWS of the same kind (cash_opening or
--     opening_balance): merging would lose or double one of them — exposure
--     reads the latest cash opening, the register sums them. Refused as v93
--     refuses it.
--   · A FOREIGN ACCOUNT ON THE ROW THAT WOULD FOLD: a live account that is
--     not one of this person's (and is not a synthesised hotel 'name:' key,
--     which is a pointer to the row's own name). Folding that row would drag
--     somebody else's account onto this man — the very mistake a wrong link
--     makes, and the one sql/schema_v101.sql had to undo for the Yango
--     "MUHAMMAD KHALID" the same morning.
-- Either way the two rows stay apart, a REFUSED audit row says why (once),
-- and a warning is raised; the person is merged through POST
-- /api/person/merge once somebody has resolved it.
--
-- EACH PERSON IN ITS OWN SUB-TRANSACTION. One person whose fold raises — a
-- table that references driver(id) added after this file — is that person's
-- problem, recorded as a warning; the other 191 are still folded. The same
-- lesson src/persons.js records for its own loop.
--
-- ── IDEMPOTENT ───────────────────────────────────────────────────────────
-- On a database where none of a person's accounts is placed — every fresh
-- one, every test — there is nothing to fold and the spine places them on one
-- row itself. Once folded, every account is on the survivor and the inner
-- loop finds nobody: a replay moves nothing and writes no second audit row.
--
-- THE LIST BELOW IS GENERATED from api/identity_map.js — every key carrying
-- an entry verified 2026-10-08, its survivor, every alias id on the key, and
-- the ruling's words — and test/identity_review_merge.test.mjs fails if the
-- two drift. It is a snapshot of the ruling, as it must be: a migration that
-- read the register at boot would merge whatever the register said next.
DO $mig$
DECLARE
  people CONSTANT jsonb := $list$[
{"k":"aamir khan amin","keep":"efa5df29-c8ac-47d7-9ce2-be046f5d3a0f","alias":["1d910e38d0a5451ea5b4c45df2706c5e","6628151","67483c64055e070d7910011e"],"words":["Yes, all 184"]},
{"k":"abas osman abyan","keep":"c417490e-a60a-4fb3-b4d8-c16673008e0a","alias":["7714111","bb9ef8895f9e4e5c8947258ef0ae1503"],"words":["Yes, all 184"]},
{"k":"abass tanko","keep":"dbbeb72d-716a-4327-8705-f08dae83a240","alias":["41a6094035854fa49079fd38fff276ec","6598737","67483c64055e070d7910011c"],"words":["Yes, all 184"]},
{"k":"abdelmohsen said ghanem","keep":"a7ee8da6-f312-4b76-b925-f6682e2fed12","alias":["6901485","785f350f-47d2-4b3a-99a5-923f01d8f7c9"],"words":["Yes, all 184"]},
{"k":"abdul basit aman","keep":"6d609028-a86c-4cee-92ef-7bae26e0cca8","alias":["48de0d9f0a7c493f83724bae1f8dd257","8168176"],"words":["Yes, all 184"]},
{"k":"abdul basit ayaz ahmed","keep":"89886d77-952a-4df7-b206-8ada3b9afc78","alias":["02cec98f-25ae-4cb9-9fd5-671920f958ac","6611346"],"words":["Yes, all 184"]},
{"k":"abdul hannan momin","keep":"ea186ae2-197c-4a1c-a1cd-ae56643e6f73","alias":["6610828"],"words":["Yes, all 184"]},
{"k":"abdul malik muhammad iqbal","keep":"975db95e-0c42-4909-8597-53ffe66fadaf","alias":["6628607","67483c64055e070d791000d6"],"words":["Yes, all 184"]},
{"k":"abdul salim aziz abdul gaffur","keep":"55833ba1-0dcb-4a6a-a7f0-5148819e600d","alias":["6611334","92a8c1c8-f5ab-462a-99a3-165dc3fbe6c2"],"words":["Yes, all 184"]},
{"k":"abdullah ahmad ullah khan","keep":"67483c64055e070d7910010e","alias":["23a584f3-cfc7-450e-bb42-6a71ebf0d613","6628743","d5eb68b8397a449d82003ddf3faa52fa"],"words":["Yes, all 184","ticked as the same person"]},
{"k":"abidullah safi","keep":"dae09063-88a3-432e-b39f-969d8de7992b","alias":["60e3d6c96fd44a5599ba7d326db30f47","6a5645c839f87dec92ca9386","7208744"],"words":["Yes, all 184"]},
{"k":"abu bakar saddique kamil shah","keep":"5779be46aefa4bacaa413aa861219444","alias":["7399815","d6d4e1cb-296f-4ef5-8270-3653ef546a02"],"words":["Yes, all 184"]},
{"k":"abusaad siddiqui akhlaque ahmad","keep":"68f744f88c482942eaaba18b","alias":["8110251","beada3aa-c836-47d2-9100-feea4b1f31e2","d6892f17ac534650b6855ffa3161f6bb"],"words":["Yes, all 184"]},
{"k":"aftab ahmed muhammad sharif altaf","keep":"68905c41d0a931b9d7544982","alias":["7726833","78b5741e-1c72-4b56-907f-da18807e5f57"],"words":["Yes, all 184"]},
{"k":"ahmed mohamed gadalla","keep":"54c5a53d-ca40-4206-8a04-1f63d828e1c1","alias":["60003270-6e09-495b-b801-bbf4c6b7aa53","6611279"],"words":["Yes, all 184"]},
{"k":"alakbar rahimov","keep":"cf08a7df-1a9f-450c-92aa-baa8d9da5f7b","alias":["69707aaeb905b635fcc054f3","7b1408ba9a154514b1d2c6182eaf2d75","8219954"],"words":["Yes, all 184"]},
{"k":"ali abbas ahmed","keep":"9e9060e7-0b8c-4f3b-8cd7-165d5eac55cd","alias":["6623821","680790c003051f14d956b356","b17bcd50-e20b-4055-80d8-468131188397"],"words":["Yes, all 184"]},
{"k":"ali nawaz muhammad nawaz","keep":"67483c64055e070d791000f0","alias":["10e01fb59b184ab88dc750704a9bc10e","42114339-fce7-448d-a4b5-b22aeea680cf","6623707"],"words":["Yes, all 184"]},
{"k":"ali raza shah","keep":"3cf1fcd4-1087-4b72-8598-6dffe3fe86e0","alias":["0cb17332-9d08-4d1e-8806-898ad47d784d","7202128"],"words":["Yes, all 184"]},
{"k":"alzain alfatih ahmed","keep":"8d545a2e-725f-488d-9498-0870a0bffb87","alias":["2b53af79-175b-4ff4-bd2e-545c2d409ce9","8555822"],"words":["Yes, all 184"]},
{"k":"aman ullah amir mehboob alam","keep":"68766d7d03051f14d95a8209","alias":["41b08fe8-4e12-4541-bb74-51c44bd54357","7569135"],"words":["Yes, all 184"]},
{"k":"amir muhammad khan muhammad naeem khan","keep":"1ffc17512bae40d2a6899f35aad12789","alias":["7874177","d9b2de76-b535-4b23-a714-7e31724e50d2"],"words":["Yes, all 184"]},
{"k":"amshid khan","keep":"e6fd4328-b270-4e7e-bff8-2c6e0f290a28","alias":["6633456","67483c64055e070d791000e5","9c09415b-9aa2-43dc-ac9e-298c3c72ac32","c7a289421a5848ee9bfacf71b133fc24"],"words":["Yes, all 184"]},
{"k":"andreh elias aoun","keep":"eb7c8909-2a1b-418d-a920-49dced4913e0","alias":["567a259c-9610-4fea-9704-7e9bfd8397ad"],"words":["Yes, all 184"]},
{"k":"ansar murtaza butt rashid murtaza","keep":"67483c64055e070d791000e0","alias":["6623712","84dea951-8a05-4b19-8b88-072ac72f3d2c","e2e561163b1b40aaa79b82a87be40f6b"],"words":["Yes, all 184"]},
{"k":"arbab hassan rab nawaz","keep":"68766dbe03051f14d95a8210","alias":["6d707fcd-fe3d-43f3-b0b9-778c798cacd0","7605526","ca4b038d57a146698bca6c1b1e0a999a"],"words":["Yes, all 184"]},
{"k":"arivoli rajendran","keep":"2d4e39b2-43cb-4e51-ac1f-cd4fc0612528","alias":["6611196","fb82dc91-90f6-4f1b-9793-b97ccea96640"],"words":["Yes, all 184"]},
{"k":"arslan arif","keep":"dbd55f2e-ffeb-479d-b8f0-75c8acf186b5","alias":["7547689","92ec45d804f34718a8ed6214cfb99b4d"],"words":["All 27 are the same","Yes, all 184"]},
{"k":"asif mehmood abdul qadeer","keep":"e1fb2ce2-8ab3-4897-aa6d-209b91df2fff","alias":["6611368","d7cf380a-7777-431f-ac84-78afe493988d"],"words":["Yes, all 184"]},
{"k":"atif shabbir","keep":"a5465ff1-317a-4d67-ac54-cce9999f725c","alias":["6623561"],"words":["Yes, all 184"]},
{"k":"bashir ahmad amin","keep":"369dd9c1-ae0a-4526-8d46-d91a8c217121","alias":["6a8dac427ba7dbf44436ca89","8483922","a41efffe-2f84-43ad-8f92-f50f755a1d55"],"words":["Yes, all 184"]},
{"k":"bilal ahmad haji rehman","keep":"67483c64055e070d79100106","alias":["6628147","6e53bb51-d55e-4370-b855-10cb8025b936","ed0cc768ec3d46f4b8932dfbf24f12f3"],"words":["Yes, all 184"]},
{"k":"binu abdul rehman kunju abdul rahman kunju","keep":"06e30918-61b9-4543-8a38-b7ff787c1b44","alias":["808537b4-e268-4c3c-bac1-fc1cf6c74004"],"words":["Yes, all 184"]},
{"k":"cedric wendkuni kabore","keep":"8e4e351c-aba6-4141-994f-55cffd844191","alias":["68766c9e03051f14d95a81f4","7523326"],"words":["Yes, all 184"]},
{"k":"chahat ravinder","keep":"23a9d6f0-c916-477d-8624-91038a7d9fb8","alias":["9048361","c9943fab-aca7-42c3-a7b6-bb91a298f1b3"],"words":["Yes, all 184"]},
{"k":"chingiz seftarov","keep":"8b41f469-689e-455d-8b00-ff2a37d9a7ec","alias":["4ca00da1-292a-464e-82c5-f7702b135331","8108061"],"words":["Yes, all 184"]},
{"k":"danish rehman haji rehman","keep":"67483c64055e070d79100111","alias":["3c0d36fd2caf48fbb45a10e8cf9aab1d","6623840","6a242abc-ea2e-4a67-8d70-ce4644875dd5"],"words":["Yes, all 184"]},
{"k":"dawit zeraye haile","keep":"4880dbcc-f2dd-45ed-a2b9-900bb61bc93b","alias":["7238992","d10ed574-6f79-4f07-990a-5ec7f91a2df4"],"words":["Yes, all 184"]},
{"k":"dev bahadur gurung","keep":"a5f9214e-4f6f-4037-bf0a-631bc6ff5343","alias":["93378ac8-6756-439c-9c92-e298ece77c33","9593727"],"words":["Yes, all 184"]},
{"k":"dhavooth ibrahim abdul kadhar","keep":"8875bda1-9a0a-4337-adbb-43926ad278ea","alias":["b4f0558b-284b-4d91-b40a-5ed7b8c11c67"],"words":["Yes, all 184"]},
{"k":"durga prasad basyal","keep":"67483c64055e070d791000cb","alias":["449077790a0e4ac5a64585d4eb68eda1","4abd6016-c582-44f9-8bf7-6af054d0cbe6","6611221"],"words":["Yes, all 184"]},
{"k":"edwin nyasani mandere","keep":"6a48ed8f13880329d04ebbbd","alias":["513d8c27-b88d-4c3e-8b20-c74680dede03","9048366"],"words":["Yes, all 184"]},
{"k":"elchin goyushov","keep":"5ab414ab-e448-420e-9701-721d4cac42fb","alias":["8170855","a4fb427a-514a-476f-9e5f-6498367f327e"],"words":["Yes, all 184"]},
{"k":"emad alabdon","keep":"f77be3df-b458-4a53-94f3-e892dbb495cb","alias":["413c9c74-c8dc-402e-98dd-7317c9855d33"],"words":["Yes, all 184"]},
{"k":"fahad mustafa","keep":"41fab64a-e93c-4f7b-847b-513f01084fda","alias":["11ebc40b-25cf-47db-91a3-8705c70ee4ef","8519700"],"words":["Yes, all 184"]},
{"k":"faisal badshah rasool badshah","keep":"67483c64055e070d79100109","alias":["6623598","9d1c60ce-e906-4ce7-ac3f-dd33eed89c99","d43113c2f35f4d7ea618c70845c85247"],"words":["Yes, all 184"]},
{"k":"faizan waris muhammad waris","keep":"6592207","alias":["221b1276-c0de-43ef-973c-0e536460337d"],"words":["Yes, all 184"]},
{"k":"farhan khan manazir khan","keep":"6628886","alias":["d43a09f3ab8a44b5ab6d35331edb59af"],"words":["Yes, all 184"]},
{"k":"farman ullah ghafoor khan","keep":"de9a4044-c57e-427c-ae06-5bca66873857","alias":["690b535b8c482942eaacb83c","8181338"],"words":["Yes, all 184"]},
{"k":"fawad ali khan ayaz muhammad","keep":"67483c64055e070d791000d0","alias":["6639159","df270275-028d-40e7-91c8-5f3b80e3efed"],"words":["Yes, all 184"]},
{"k":"fayed ali muhammad","keep":"cb5359cf-9f1f-4fcc-aee7-f79e892e78c7","alias":["2a1d4e30-e10f-4f47-a610-faae8c94d125","6780293"],"words":["All 27 are the same"]},
{"k":"haider ali khalid mahmood","keep":"6633411","alias":["67483c64055e070d7910010c","6c861462-33fa-4da4-9ef6-5d0f8d372633"],"words":["Yes, all 184"]},
{"k":"hammad ahmad","keep":"d454e6b8-6d69-469e-91a5-37c174dac8fd","alias":["4f54b70d5fd54aad8554f8c33ed20d8b","68766cd503051f14d95a81fb","7523458"],"words":["Yes, all 184"]},
{"k":"hamza iqbal sajid iqbal","keep":"a48e26a8-8c0a-41c5-bef8-72802cf1398f","alias":["48cfb2ac-0ddc-4742-96ed-6b1d2a09c491","68b94a08b0dc20d631c56a68","7838158"],"words":["Yes, all 184"]},
{"k":"harish kumar chand","keep":"f6a10bac-7ea4-4b9a-b37a-a817aad5d7f9","alias":["6628149","688a1c98a0bf23d354fda5a7"],"words":["Yes, all 184"]},
{"k":"hasan wadie alabaza","keep":"2c06cfc8-df51-4c32-af89-64fb16699a1b","alias":["6611356","f9aa707b-6b85-460c-91c5-b88df7808758"],"words":["Yes, all 184"]},
{"k":"hassan elsayed hassan","keep":"19a4453f-a38b-4142-93f5-979b96b681a6","alias":["7294843","83cf7ce5-764e-4588-994f-d415566288c1"],"words":["Yes, all 184"]},
{"k":"hassan munawar shaad","keep":"454fefba-ff66-4995-b9c5-f70d1fda7dd5","alias":["6880673","f157aac8-ff4d-489d-9d35-1d96ffc5e4ca"],"words":["Yes, all 184"]},
{"k":"hassan talaat kamel abousira","keep":"293f7986-1768-4c56-8317-133ee31d89fb","alias":["69046cc38c482942eaac6ee7","8143925"],"words":["Yes, all 184"]},
{"k":"henok melese amdisa","keep":"2e9e87f5-7b0e-4ccd-af22-64d6bec268f4","alias":["7003039","8b20b014-d999-41cf-965f-c10363175d5e"],"words":["Yes, all 184"]},
{"k":"henry martin motha","keep":"550133d0-affd-45b4-9082-0a95a39bd09f","alias":["48a7ee6e-f6d7-4491-a811-798263d4616f","6904614c8c482942eaac6e48","8120259"],"words":["Yes, all 184"]},
{"k":"hussain ansar","keep":"5e3b947b-b927-47be-9845-24d6842acf0e","alias":["58de23fbd6e14a4389b7557c732ee607","7624035","90f893d3-7595-4743-8efe-62b2815677b7"],"words":["Yes, all 184"]},
{"k":"ifraz ahmed ghulam ahmed","keep":"68766c6303051f14d95a81ed","alias":["7523359","bb4b1157-37e9-443c-82ef-1fb33660e9ad","d22a7087f9ac42119cbe936749cd0bf1"],"words":["Yes, all 184"]},
{"k":"imad khan darwish khan","keep":"6628162","alias":["67483c64055e070d79100124"],"words":["Yes, all 184"]},
{"k":"irfan ullah awal ameen","keep":"04c30a0a-1d4f-40f3-b9aa-378ed5ceeee4","alias":["67483c64055e070d791000f1","6814489","f7aad3d6075f4e788a303ce744d9986c"],"words":["Yes, all 184"]},
{"k":"javeed ahmed abuthahir","keep":"924ba67f-0ebf-48eb-b30b-0feffe302088","alias":["6ac5f35a6e0dbece4b48591e","9674928"],"words":["Yes, all 184"]},
{"k":"jawad khan gohar","keep":"1c16bca7-d064-42b6-bc63-04758e74a06e","alias":["68766b8003051f14d95a81dc","6901251"],"words":["Yes, all 184"]},
{"k":"joseph wandera","keep":"1e2311ad-cc26-4e2b-839a-41363ef67672","alias":["68e368e3ff76a73626e0720e","7976866"],"words":["Yes, all 184"]},
{"k":"kashan malik abdul malik","keep":"67483c64055e070d791000fc","alias":["6628224","ec9980b3-9663-43ac-9444-a1fc81675c0a","f4a294bd4b48456496921e542e58e79e"],"words":["Yes, all 184"]},
{"k":"kashif ali ayyub khan","keep":"84d498cf-a74a-4750-9ac2-5eabdeec3b8d","alias":["6620158","67483c64055e070d791000e3","a411e6c0e37c42f4869f4b230fc78292"],"words":["Yes, all 184"]},
{"k":"kazi fuad ahmed kazi alim ullah","keep":"67483c64055e070d791000ca","alias":["6610628","8cf0d6e0-5399-4686-81fd-2aa8682ce786","a9634a34f151436da7669fda9cc58bbc"],"words":["Yes, all 184"]},
{"k":"khalid abdalrahman albadwi","keep":"fc05f592-46a1-4353-b843-88e5c6dbec2c","alias":["6610644","67483c64055e070d791000c7"],"words":["Yes, all 184"]},
{"k":"khan akbar khan","keep":"be22c2b6-fd77-4956-9b72-139eeb61d71f","alias":["1f1bb8d4-9a08-41ae-b376-0135ca67a431","8519699"],"words":["Yes, all 184"]},
{"k":"leon anthony marcus","keep":"97e08f41-1b0c-44b5-98bd-bfdea50a2c24","alias":["5edfb1b3-25a5-42f7-9759-4f3e4f22c4d6"],"words":["Yes, all 184"]},
{"k":"maen m alaa shekfa","keep":"67483c64055e070d79100133","alias":["00c0221c4aec47db9813f6c525167561","6628845","e4cb0cd6-a078-461b-984a-b7c6fc32a247"],"words":["All 27 are the same","Yes, all 184"]},
{"k":"mahaz ahmad darwaish khan","keep":"f1bbe420-bd7f-43e0-b8d4-8ecd5e8f4719","alias":["6616065","67483c64055e070d791000e1","fa7219517bf24cefb719ec1b28e9a913"],"words":["Yes, all 184"]},
{"k":"maimaitiyiming abuduhaibaier","keep":"6997355","alias":["cf47057f-57d4-480c-b581-23edc94a542a"],"words":["Yes, all 184"]},
{"k":"majid shah mehboob shah","keep":"67483c64055e070d791000ee","alias":["4963067e-9979-411e-8c66-926ca581a0f2","a4da2085550d423f9c20d374473e474f"],"words":["Yes, all 184"]},
{"k":"mansoor mohammad naeem","keep":"fd0284aa-489a-4e53-aa9d-23c2512fe2dd","alias":["7416662","ba2f3489-1277-4a64-9671-f800173b0aae"],"words":["Yes, all 184"]},
{"k":"maqsood muhabat shah","keep":"bed790a1-d986-4b0d-b6a3-5f9854789263","alias":["6934090"],"words":["Yes, all 184"]},
{"k":"mateen gul","keep":"31ec8c94-1f92-4fe8-bcd3-8bf83ae928be","alias":["352cdd896af14ffca96d2fb943c99ad0","6628730"],"words":["Yes, all 184"]},
{"k":"mati ullah sharif khan","keep":"67483c64055e070d791000f7","alias":["33cce538-9975-4d96-b770-df1178d2ad5c","6781253","735cc1574bfd46de8cfa7ed449d371f8"],"words":["Yes, all 184"]},
{"k":"midrar khan","keep":"6f48f5a4-747f-4272-bbec-a413272103e5","alias":["6634999","67483c64055e070d7910011a"],"words":["Yes, all 184"]},
{"k":"mirza abdullah baig mirza zahid baig","keep":"67483c64055e070d7910010d","alias":["16b7df80-d744-4dc4-87d2-7a7d588d849e","6628129","9d77089bcf574517850372f447977d30"],"words":["Yes, all 184"]},
{"k":"mohamed essam abdelfattah","keep":"e3796787-f3f9-41f9-a299-2e5862cbbf76","alias":["208a7776-fc88-4604-ab49-631437b77dd5","6818383"],"words":["Yes, all 184"]},
{"k":"mohammad asif ahmad","keep":"7c19932d-f2de-45a2-ad08-b01a4b87b988","alias":["8051700","90c2e390-2820-4d26-8cf3-2b84ca717c55"],"words":["Yes, all 184"]},
{"k":"mohammad mokdassel md obaidullah","keep":"67483c64055e070d79100125","alias":["4688f7772f494801902447e10c6df649","6628253","6a37fe4f-8f44-4af0-a043-5cc3e1ffdcb1"],"words":["Yes, all 184"]},
{"k":"mohammad naeem adam khan","keep":"67483c64055e070d79100117","alias":["6615750","d31e25fa-dc28-424c-a6e5-c2cbcf516870"],"words":["Yes, all 184"]},
{"k":"mohammed alsoos","keep":"67483c64055e070d7910012f","alias":["518aacd8fd9347bca83baef90671cb77","6628504","ba5e864f-6035-469c-97a1-db3e4a087385"],"words":["Yes, all 184"]},
{"k":"mohammed fazlul siddik","keep":"70f25511-3dd2-486a-927f-e19d5c2482ca","alias":["0876b449-12ca-45dd-8f44-262b901a4772","6611186"],"words":["Yes, all 184"]},
{"k":"mohammed musab rahmathulla","keep":"2c085db3-dbb1-48a6-99ca-0af7e5ee3ea5","alias":["2bde54e1ec3d46e787c3562a15459a16","68905130d0a931b9d7544863","7643640"],"words":["All 27 are the same","Yes, all 184"]},
{"k":"mohd shohidul islam shamsul alam","keep":"45be24f8-e15a-4a94-897a-23f52daa16a8","alias":["6611263","c366fc8a-a007-461a-b06d-256d9c411c85"],"words":["Yes, all 184"]},
{"k":"moidutty sanafu cherunambi moidutty","keep":"8688313","alias":["8af4f8d8-c28b-4eef-be5b-609947c9567c"],"words":["Yes, all 184"]},
{"k":"moidutty sanafu moidutty","keep":"22a30136-f671-4d0f-a78e-109d255769b3","alias":["6a042a98284c6a4354627f36"],"words":["Yes, all 184"]},
{"k":"moses bale","keep":"628fbdea-1404-4289-a5b5-9bab4dc69cf0","alias":["68e36905ff76a73626e07220","7976847"],"words":["Yes, all 184"]},
{"k":"muhammad abid ali khan noor","keep":"67483c64055e070d791000de","alias":["0b4d7f5b-086e-4f40-96c6-2e2ffe727214","6639693"],"words":["Yes, all 184"]},
{"k":"muhammad ahmad ghulam qadir","keep":"6a7f3e80d87732ee9b2068a3","alias":["8b6b8f45-eda3-44be-85d8-0d45d9dad64e","9324842"],"words":["Yes, all 184"]},
{"k":"muhammad ali bajwa","keep":"03e77aa0-87b4-4a8a-a2ec-2784d831c4f8","alias":["6864801"],"words":["All 27 are the same"]},
{"k":"muhammad amir misree khan","keep":"67483c64055e070d791000d3","alias":["6640621","b00986ad-2af2-4fac-babd-df87d3cd5a05"],"words":["Yes, all 184"]},
{"k":"muhammad aqib khan","keep":"b2093c44-92a7-4d03-8c43-0b28ac199252","alias":["6628172"],"words":["All 27 are the same"]},
{"k":"muhammad asif zada","keep":"6ee7b8e2-c47d-46be-ac7b-d0c74c36391c","alias":["6640364","67483c64055e070d7910010b","9407cd209754464885335d800596c5ae"],"words":["Yes, all 184"]},
{"k":"muhammad asim shahzad","keep":"42316a17-6fc9-49f4-af07-b5676ac04eeb","alias":["9642366"],"words":["Yes, all 184"]},
{"k":"muhammad faraz khan","keep":"c4febff7-604d-4ce8-90db-d0730bcac155","alias":["35067d2a-3f1e-402e-97f3-fc87657c8153","6997157"],"words":["Yes, all 184"]},
{"k":"muhammad hanan munir muhammad munir","keep":"688085f5a0bf23d354fd60b0","alias":["3113020f-f05b-4f77-882b-394cce34efc7","7643624","bdc98198249e4b6698131d2b5667bcd7"],"words":["Yes, all 184"]},
{"k":"muhammad haris bangash","keep":"4392d188-e2fb-4a7d-999d-693e648b4e55","alias":["8035834","87a43a33-2869-44ba-94d5-c9109c308daa"],"words":["Yes, all 184"]},
{"k":"muhammad hasham tanveer ahmad khan","keep":"67483c64055e070d791000e2","alias":["147935b6-3c73-4689-a5f2-3efd07d91c12","7300699"],"words":["Yes, all 184"]},
{"k":"muhammad hussnain muhammad rafique","keep":"6594329","alias":["6cf65aa1-b9b6-4efc-b006-a0a4bde7a2f4"],"words":["Yes, all 184"]},
{"k":"muhammad ihtisham zaman","keep":"a0644707-82d1-496b-b6eb-656d9b3b32ef","alias":["6633745","67483c64055e070d7910012b"],"words":["Yes, all 184"]},
{"k":"muhammad ishtiaq khan","keep":"d1925319-0544-48c6-a2fb-a9098f311a65","alias":["41dd8378ea3a4998a7a1ad70cf1656ba"],"words":["Yes, all 184"]},
{"k":"muhammad khalifa afzal khalid","keep":"67483c64055e070d79100112","alias":["6628822","76ede4ae-768b-4126-804b-0b5c88043682","dc2705246ec84c17921d272b0aaf73d3"],"words":["Yes, all 184"]},
{"k":"muhammad masood kishbar khan","keep":"67483c64055e070d791000d7","alias":["6628159","c9948e92-9d32-40bb-91ec-1b3d124647f9","ffe3cfced8554932a6faf50538e944bf"],"words":["Yes, all 184"]},
{"k":"muhammad nadeem ajmal","keep":"1936ced0-ccd5-4db0-b07f-ab084cee7bd9","alias":["8074227","e3cd308b2b5f48e19877b924b48bbb9d"],"words":["All 27 are the same"]},
{"k":"muhammad naqeeb gull","keep":"b629aefa-7fc1-4bbe-84db-25920914105d","alias":["67731662-84af-4378-a00d-664845eaee9a","8636581"],"words":["Yes, all 184"]},
{"k":"muhammad nasir khan","keep":"7a935b56-6a30-4f25-9d0a-d556b947e23a","alias":["7312220","b5c7ce92-b5fd-4e08-bc9b-09bcc37f1ac3"],"words":["Yes, all 184"]},
{"k":"muhammad nazir khan","keep":"cc12b6f3-7ce0-4dae-afcd-4454dd36a401","alias":["6ac3a5d36e0dbece4b47dd5d","7841816","f3aded68-1b7d-4903-9837-2a6981e83083"],"words":["Yes, all 184"]},
{"k":"muhammad rahim muhammad saleem","keep":"67483c64055e070d79100103","alias":["6628824","7cf929d6-45fa-4b87-ac1f-4469ef103358","97d930a906e74d5d8d6fc25d75c2a128"],"words":["Yes, all 184"]},
{"k":"muhammad rahim rauf","keep":"e3c961d9-9bfa-439e-b711-32f825a085d5","alias":["4ea45e6f-f67f-4484-b5cf-f254e618eeab","6600403"],"words":["Yes, all 184"]},
{"k":"muhammad rashid riasat","keep":"4a4a43d2-1c84-4b62-9475-7c08b5cecd78","alias":["8274586","e125d722-cd21-4636-a38c-b2c54494c89f"],"words":["Yes, all 184"]},
{"k":"muhammad sabir jamal","keep":"716b5404-628d-47e4-827e-1477749eb75f","alias":["7194959","bfb35d1b-be59-4abe-9d35-41870fcd1863"],"words":["Yes, all 184"]},
{"k":"muhammad sameer shamrez asghar","keep":"67483c64055e070d79100131","alias":["1f5bbf3c-ba34-4dec-a28a-6af17d241033","6620288","9b9d8a53b6ea47f5a5b0e5e4ddca9d1f"],"words":["Yes, all 184"]},
{"k":"muhammad shafiq raziq","keep":"011fdd5b-54af-453e-aa17-b6f86c5fe11f","alias":["6623922","67483c64055e070d791000e9","983dc9bfe04d4bd48729325ddaa42c0d"],"words":["Yes, all 184"]},
{"k":"muhammad shahab abbasi","keep":"4e47dd44-842d-48bc-ae66-de5d08c3424d","alias":["02578759-f32e-41c7-a096-51ebe1c046aa","67483c64055e070d791000ff","6997345"],"words":["Yes, all 184"]},
{"k":"muhammad sheraz muhammad","keep":"d4862a73-6317-4fa8-ad19-8c7a95e9e74d","alias":["26d509ca-2716-4dbc-9286-95e4640f33ef","6aa01aee0b289436de6ec0d2","9120542"],"words":["Yes, all 184"]},
{"k":"muhammad talha faizullah","keep":"9efd4d0b-2db7-4f57-88e8-8450e2803f8f","alias":["467b94c54718457da9f3d434d3a5390c","6615331","67483c64055e070d79100126"],"words":["Yes, all 184"]},
{"k":"muhammad talha qureshi","keep":"9afe2406-3ca9-4061-96c2-fa0e1db93720","alias":["688218d1a0bf23d354fd7014","7636498","812895dc-41b5-4c11-bcb4-fdfdc308c73e"],"words":["Yes, all 184"]},
{"k":"muhammad toussef bangash","keep":"81cf7546-94b0-43ab-8952-cc3fbb7b88f2","alias":["691d9b128c482942eaad6aa7","8240779","decaa9ec-2f1a-483f-8be5-62f48f97b887"],"words":["Yes, all 184"]},
{"k":"muhammad usman khan","keep":"67e086af-8cb7-498f-9f4f-f4d4e2a7467a","alias":["3d226bd8-47bf-4d9e-b4d2-722756144ee9","8033691"],"words":["Yes, all 184"]},
{"k":"muhammad yaseen saeed ur rahman","keep":"5ebc7cba-8f77-487e-aba9-ae5ff0111ed1","alias":["8175513"],"words":["Yes, all 184"]},
{"k":"muhammad zeeshan muhammad shahid","keep":"4d57e153e6ff455782e4954a7862099a","alias":["6589d771-fe78-4c9a-bc9d-686c39a91e4c","6a4e97abb3b4e99c0391914e","7874167"],"words":["Yes, all 184"]},
{"k":"muhammed shahab khan","keep":"c35f5806-b4a3-41a3-8c84-b1ab7dcfbfa5","alias":["6623720","688b20bea0bf23d354fdbaca"],"words":["Yes, all 184"]},
{"k":"mummer inam ullah","keep":"1220e297-7538-4e00-be3d-5275afe760d5","alias":["4a315dee-2a2d-45b2-b2a1-cda45828ed6e","6610879"],"words":["Yes, all 184"]},
{"k":"najeeb ullah khan","keep":"00b3e873-1399-4db2-a781-1eb432fd8b9f","alias":["005211c6d1204ab89ffe0ed358cfa91a","69b7cb84cc90e854f1e4ff16","7554575"],"words":["Yes, all 184"]},
{"k":"nauman hassan shida muhammad","keep":"67483c64055e070d791000f9","alias":["6628589","72caf703fcf64d63965b80a6497428ac","8583f89a-6620-4557-a985-4c12bf08b02a"],"words":["Join those 4, leave the rest","Yes, all 184"]},
{"k":"nizam wazir zada","keep":"cc926625-4342-4b87-8311-07fc765ffddf","alias":["693a7cea8c482942eaaec601","8348168"],"words":["Yes, all 184"]},
{"k":"noorullah khan zaman","keep":"6fa73403-4c89-4be6-83ca-dada5205a0a7","alias":["6659711","67483c64055e070d79100102"],"words":["Yes, all 184"]},
{"k":"norah chia nsom","keep":"8daae9c7-5a34-4e67-a178-565b92191461","alias":["6a18229d284c6a435463e0fb","9131685"],"words":["Yes, all 184"]},
{"k":"nosher hassan bhatti","keep":"4cbf0c03-1666-444e-a164-310bb80fedf5","alias":["6620175"],"words":["All 27 are the same"]},
{"k":"rashid ali haji hussain","keep":"43183d548e3e487b9a5227705ace4719","alias":["8203414","ebe0dcf0-c554-4320-9f36-e61c17713d8d"],"words":["Yes, all 184"]},
{"k":"rashid khan muhammad","keep":"793529a4-6264-497f-9dc5-e7f4e62cbc8a","alias":["7624077"],"words":["Yes, all 184"]},
{"k":"renato romillano yap","keep":"92a7bd85-e275-4582-b792-b1922a2bf9b5","alias":["f6c68bff-3b30-436b-9481-ee0fa4da9958"],"words":["Yes, all 184"]},
{"k":"rizwan ullah muzamil khan","keep":"67483c64055e070d79100118","alias":["0a688852-8cbb-4661-ae26-a2a0057b2690","6623653","67352587e6664d86b723b25eb7dbd89e"],"words":["Yes, all 184"]},
{"k":"roy vellespen ocdol","keep":"3d3e3fa2-2e8c-43a9-8bf0-6b12dc3e26fe","alias":["6628167","67483c64055e070d79100100","ba329c7a6ac34245acf074c3250bc555"],"words":["Yes, all 184"]},
{"k":"rufat gadirli","keep":"6628166","alias":["34e629f1fab64e9a814089dc0d2a086d"],"words":["Yes, all 184"]},
{"k":"saad ali akram muhammad akram bhatti","keep":"67483c64055e070d791000d9","alias":["6907719","69845f36-babb-46b3-ae7d-d39c864bc427","dd4a45c2d6f3449da9807d81558ecbd2"],"words":["Yes, all 184"]},
{"k":"sabbir hossain shahalom","keep":"006e7f5c-f7c4-45f2-bd00-336121105d3f","alias":["67483c64055e070d791000cd","fa1379f659d343409a1807a4e0e2e1fd"],"words":["Yes, all 184"]},
{"k":"saddam hussain islam","keep":"5621f561-9a06-42ad-a85e-c10a751bb216","alias":["494e1f9c-909d-453e-8588-8c12b4c0ddcc","9492548"],"words":["Yes, all 184"]},
{"k":"sajid ayaz ahmed","keep":"67483c64055e070d79100113","alias":["13f61bb13eae43c3b0cf5d4af1c736d8","6610666","fd30bb7f-8964-4195-8e94-125ae117772f"],"words":["Yes, all 184"]},
{"k":"sajid gul muhammad","keep":"68905711d0a931b9d754492a","alias":["072492179a9c45e9b2aa438122615687","7644369","a2692332-5580-4aef-890b-48416e7eeed0"],"words":["Yes, all 184"]},
{"k":"sameh altabei elsayed mohamed","keep":"6628155","alias":["cbc987fdf3164305b62700b707905664"],"words":["Yes, all 184"]},
{"k":"sameh talaat abdelmaksoud abdelsamie","keep":"67483c64055e070d7910010f","alias":["36b941b820be498c907628b253adb32b","6628152","8fb45c4e-a2ab-413b-9069-355902279de9"],"words":["All 27 are the same","Yes, all 184"]},
{"k":"sar zamin khan shah bahadar","keep":"69411d3a8c482942eaaf083e","alias":["14852992-6178-4043-976e-4dd4e8fc72ad","8410975"],"words":["Yes, all 184"]},
{"k":"sayed kamal sayed","keep":"b7310a42-4ad3-4c88-b1ce-4fa50e226077","alias":["36aace666f914d8db5d3e5be3bb6f7fd","6616332","67483c64055e070d791000fa"],"words":["Join those 4, leave the rest","Yes, all 184"]},
{"k":"sebastian jerones","keep":"1b7f45d7-1638-4f3a-a254-8d8b3b922ff7","alias":["9503883"],"words":["Yes, all 184"]},
{"k":"shahid khan zada","keep":"eb7962e5-0c47-45c0-b758-b61e6dd12998","alias":["6a291640284c6a4354651585"],"words":["Yes, all 184"]},
{"k":"shajahan mk","keep":"9585892","alias":["0f314ca4-fedd-4de5-9b48-59f274776381"],"words":["Yes, all 184"]},
{"k":"shehzad ahmad ghulam muhammad","keep":"f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2","alias":["4e75cfb248fc45dd8bc41c460e956bfb","6612891","67483c64055e070d7910010a","b826dc16c41248b1a5005750d255231b"],"words":["ticked as the same person"]},
{"k":"sheraz rehman khan","keep":"2c445083-99b6-411f-bd9d-5b6823b80b9d","alias":["6800964"],"words":["All 27 are the same"]},
{"k":"sikandar tariq hussain","keep":"39042c26-8985-4f99-af1c-a990a63834e6","alias":["8074837","f7d8a0ff324641b1bc96c649290da826"],"words":["Yes, all 184"]},
{"k":"siyad kallyanathoppil paramba","keep":"12ce7e65-2ce7-4629-b958-17bb7a4e7bb8","alias":["6d175dd8-8d9c-4c88-8399-5b5c8a5efb85","7779693"],"words":["Yes, all 184"]},
{"k":"soaieed alom ali","keep":"fb7c2c86-4ba0-41d6-b73f-6e9dd77b08ff","alias":["6639200","67483c64055e070d791000cf"],"words":["All 27 are the same"]},
{"k":"tariq afzal","keep":"7e96cb47-f2d4-4f96-9019-0ee79eb0117d","alias":["69f7e655aab1412c83a9c6d4d58aa122","7308211"],"words":["Yes, all 184"]},
{"k":"ubaid ullah hassan muhammad","keep":"9cf2c3e7-896a-4265-9600-0a5c16bbc9fe","alias":["67483c64055e070d791000ce","6835351"],"words":["Yes, all 184"]},
{"k":"ullal abdul rasheed kotepura","keep":"72d2f062-70d0-404a-8b52-00b4534446a2","alias":["1fc71474-5345-46e9-b7d9-3f5a38bbdbf0","68821890a0bf23d354fd700d","7501194"],"words":["Yes, all 184"]},
{"k":"umair ahmad gul","keep":"7ff1e0bb-8c80-4948-9cd8-86902625ac40","alias":["6640352","67483c64055e070d791000eb","b3edf09c58f542e98ff5bd1068d178e8"],"words":["Yes, all 184"]},
{"k":"umairuddin mohammed zameeruddin","keep":"84f3c41d-2e32-432d-8d6a-a565184d1068","alias":["2df8f636-2964-4163-a164-b09154f92c80","6940023"],"words":["Yes, all 184"]},
{"k":"umar ali zarid khan","keep":"67483c64055e070d791000f8","alias":["6628957","758b9949-6042-4c2d-b6f0-aebe8501d5be","7859266"],"words":["All 27 are the same","Yes, all 184"]},
{"k":"umar kayani nasir waheed kayani","keep":"67483c64055e070d791000da","alias":["6628548","cac5cfedf0df4f90a0086cefc297d535"],"words":["Yes, all 184"]},
{"k":"umer naveed abdul qadir","keep":"67483c64055e070d791000db","alias":["563467d09d3d4f629b8b65e9c67d591f","6611555","b4a7efd8-2808-4058-8595-635918c6bcf2"],"words":["Yes, all 184"]},
{"k":"wahab ali zada","keep":"261a9688-e59e-4b73-bf1a-3bbb2f52a271","alias":["6a4f4253b3b4e99c0391a15e","72191eb6-9500-4974-a4cc-b8211333e809","7841834"],"words":["Yes, all 184"]},
{"k":"wajahat khan","keep":"eeaac51c-2c12-48cf-aee7-5593ee6573ad","alias":["67483c64055e070d791000e6","6785544","a206c164ad194fe385209d40a17e5246"],"words":["Yes, all 184"]},
{"k":"wajid akbar khan","keep":"00dc098e-2f65-4b6b-9fbd-47305cdb18e0","alias":["5d42345bcf4440df93645a54aedb9bc6","7158151"],"words":["All 27 are the same"]},
{"k":"wajid ali ameer bakhsh","keep":"0a59fd2f-6fcc-497f-b274-4462bbc3ddf3","alias":["67483c64055e070d791000dc","6901260","ffe30d6937114c1282457ed38010d274"],"words":["Yes, all 184"]},
{"k":"wajid rehman nausherwan","keep":"ca15a7c6-5df0-4bdc-abec-918c78876c47","alias":["67483c64055e070d791000fb","6939735"],"words":["Yes, all 184"]},
{"k":"waqas riaz","keep":"f9ac5f80-275c-4320-b9c5-0535e69dfceb","alias":["7727920","a604d59c88e94a758ce9a19264fec2dc"],"words":["Yes, all 184"]},
{"k":"waseem abbas ghulam nabi","keep":"6911c82f8c482942eaacf939","alias":["4056c8cc-3c12-41ba-9948-e7e740d67fbe","8185992","82b0abaeab4c4ee3b95fa8094978ca9a"],"words":["Yes, all 184"]},
{"k":"wisal muhammad","keep":"64686123-8389-4a9e-82f1-0287e936239b","alias":["122e8a0195354a0090474be38680ca2c","6610938","67483c64055e070d791000f5"],"words":["Yes, all 184"]},
{"k":"wunibie mohammed issah","keep":"c0520901-3066-4f65-977c-a40e324e38ae","alias":["76f1b791-52ad-4c1a-899c-c2b9c2d8db36","9481149"],"words":["Yes, all 184"]},
{"k":"younas khan shah","keep":"e6c4ae1e-b424-4b42-ad68-153dc8f7b823","alias":["7416327"],"words":["All 27 are the same"]},
{"k":"yousaf ali javed iqbal khan","keep":"6629009","alias":["6f564b8c1a334a7eb9953614300d8e85"],"words":["Yes, all 184"]},
{"k":"zahid ezazullah","keep":"1da7bc60-8f0c-47e5-a25d-e7e30647faed","alias":["6623648"],"words":["Yes, all 184"]},
{"k":"zahid khan","keep":"c33cc3d6-77d2-4e13-a916-f08a89daf2bb","alias":["3343a680ce234548998464bfd7784cb3","6616272","67483c64055e070d791000f4","c74f4bf5fe2f45bfbd3c42a68857f3f0"],"words":["Yes, all 184"]},
{"k":"zahid khan ismail","keep":"992df6d8-7069-409c-b93d-3f638817ac49","alias":["67483c64055e070d79100121"],"words":["Yes, all 184"]},
{"k":"zahid ullah afsar zada","keep":"faab28eb-79bf-4863-b430-1d0d2167bb05","alias":["6663860","67483c64055e070d79100127"],"words":["Yes, all 184"]},
{"k":"zain ali ghulam hassnain","keep":"67483c64055e070d79100120","alias":["6633916","b14f2b04795c411b8c01b2edc2a37774","fb09dfee-cf6d-4391-8b57-e45e0e9ec743"],"words":["Yes, all 184"]},
{"k":"zain hassan raja nasrullah khan","keep":"c873a0fe-fea0-47a1-8b0d-e620e9675610","alias":["36f2a997f1ef434fa3fbd2d63d945c05","9081508"],"words":["Yes, all 184"]},
{"k":"zain ul abideen muhammad irfan","keep":"67483c64055e070d791000df","alias":["362aca28-e48d-4c09-bce2-f5fe23266723","6610637"],"words":["Yes, all 184"]},
{"k":"zeeshan ahmad ur rahman","keep":"76aa7207-cd18-4498-a9b6-e11d8b45e266","alias":["4517ca6e-8b79-4bd4-8e4d-88c86d5dd6b9","6842136"],"words":["Yes, all 184"]},
{"k":"zeeshan nadeem akram","keep":"8189219b-6037-4114-9e80-4847e7cd842f","alias":["6611073","67483c64055e070d79100132"],"words":["Yes, all 184"]},
{"k":"zia ali said muhammad","keep":"67483c64055e070d7910012d","alias":["4ce6eea7-ea84-49d9-b6c5-14f67d3f5cc3","6640532"],"words":["Yes, all 184"]},
{"k":"zia ullah nasrullah khan","keep":"f01ca0ae-6f62-406e-8115-a881f33a811e","alias":["6628537","67483c64055e070d79100108","805583c3bc6e450aa33ad320e991e714"],"words":["Yes, all 184"]},
{"k":"zubair khan shaukat ali","keep":"67483c64055e070d791000e4","alias":["5d1cd81e68944856a6274c458d5ee4f0","6616229","a83f63fc-88bb-4bbd-9ee3-55d5aeb00e8c"],"words":["Join those 4, leave the rest","Yes, all 184"]},
{"k":"zubair muhammad afsar muhammad","keep":"80353b2843844d6683b39450d0d458fa","alias":["67483c64055e070d791000ef"],"words":["Yes, all 184"]}
]$list$::jsonb;
  p          jsonb;
  keep_acct  text;
  key_ids    text[];
  keep_id    bigint;
  keep_name  text;
  keep_rule  text;
  d          record;
  clash      jsonb;
  foreign_a  jsonb;
  accts      jsonb;
  entries    jsonb;
  n_entries  int;
  amt        numeric;
  audit_ids  jsonb;
  sms_ids    jsonb;
  ruling     jsonb;
  why        text;
BEGIN
  FOR p IN SELECT value FROM jsonb_array_elements(people) LOOP
    keep_acct := p->>'keep';
    key_ids := ARRAY[keep_acct] || ARRAY(SELECT jsonb_array_elements_text(p->'alias'));
    ruling := jsonb_build_object('by', 'operator', 'on', '2026-10-08', 'words', p->'words',
      'register', format('api/identity_map.js — key ''%s''', p->>'k'));
    keep_id := NULL;
    SELECT a.driver_id, dr.full_name, dr.cash_rule
      INTO keep_id, keep_name, keep_rule
      FROM driver_platform_id a JOIN driver dr ON dr.id = a.driver_id
     WHERE a.external_id = ANY (key_ids) AND a.detached_at IS NULL
     ORDER BY (a.external_id = keep_acct) DESC, a.driver_id
     LIMIT 1;
    CONTINUE WHEN keep_id IS NULL;   -- not placed: the spine places them on one row

    FOR d IN
      SELECT DISTINCT dr.id, dr.full_name, dr.cash_rule
        FROM driver_platform_id a JOIN driver dr ON dr.id = a.driver_id
       WHERE a.external_id = ANY (key_ids) AND a.detached_at IS NULL
         AND a.driver_id <> keep_id
       ORDER BY dr.id
    LOOP
      BEGIN
        /* Refusal 1: somebody else's account on the row that would fold. */
        SELECT jsonb_agg(jsonb_build_object('platform', platform, 'ext_id', external_id)
                         ORDER BY platform, external_id)
          INTO foreign_a
          FROM driver_platform_id
         WHERE driver_id = d.id AND detached_at IS NULL
           AND external_id <> ALL (key_ids) AND external_id NOT LIKE 'name:%';
        /* Refusal 2: an opening of the same kind on both rows. */
        SELECT jsonb_agg(jsonb_build_object('type', type_code, 'person_id', person_id,
                                            'entry_id', id, 'amount', amount,
                                            'on', to_char(effective_on, 'YYYY-MM-DD'))
                         ORDER BY type_code, person_id, id)
          INTO clash
          FROM driver_ledger e
         WHERE e.person_id IN (keep_id, d.id)
           AND e.type_code IN ('cash_opening', 'opening_balance')
           AND e.entry_source <> 'verification'
           AND e.type_code IN (
             SELECT type_code FROM driver_ledger
              WHERE person_id = keep_id AND type_code IN ('cash_opening', 'opening_balance')
                AND entry_source <> 'verification'
             INTERSECT
             SELECT type_code FROM driver_ledger
              WHERE person_id = d.id AND type_code IN ('cash_opening', 'opening_balance')
                AND entry_source <> 'verification');
        IF foreign_a IS NOT NULL OR clash IS NOT NULL THEN
          why := format('%s was NOT folded into %s (key ''%s''): %s The operator ruled them one '
            || 'person on 2026-10-08; fold them through POST /api/person/merge once that is resolved.',
            coalesce(d.full_name, 'person ' || d.id), coalesce(keep_name, 'person ' || keep_id), p->>'k',
            CASE WHEN foreign_a IS NOT NULL
              THEN 'that row also holds an account that is not this person''s, and folding it '
                || 'would carry that account onto him.'
              ELSE 'both carry an opening of the same kind, and merging would lose or double one '
                || 'of them (exposure reads the latest cash opening, the register sums them).' END);
          IF NOT EXISTS (
            SELECT 1 FROM driver_ledger_audit
             WHERE action = 'person_merge' AND outcome = 'refused'
               AND payload->>'via' = 'sql/schema_v102.sql'
               AND (payload->>'drop')::bigint = d.id AND (payload->>'keep')::bigint = keep_id) THEN
            INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id, payload)
            VALUES ('operator', 'person_merge', 'refused', why, keep_id,
                    jsonb_build_object('keep', keep_id, 'drop', d.id, 'by', 'operator',
                                       'via', 'sql/schema_v102.sql', 'key', p->>'k', 'ruling', ruling,
                                       'foreign_accounts', foreign_a, 'openings_on_both', clash));
          END IF;
          RAISE WARNING 'schema_v102: %', why;
          CONTINUE;
        END IF;

        SELECT coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'ext_id', external_id,
                                                     'detached', detached_at IS NOT NULL)
                                  ORDER BY platform, external_id), '[]'::jsonb)
          INTO accts FROM driver_platform_id WHERE driver_id = d.id;
        SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'book', book,
                                                     'type', type_code,
                                                     'on', to_char(effective_on, 'YYYY-MM-DD'))
                                  ORDER BY id), '[]'::jsonb),
               count(*), coalesce(sum(amount), 0)
          INTO entries, n_entries, amt
          FROM driver_ledger WHERE person_id = d.id;
        SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO audit_ids
          FROM driver_ledger_audit WHERE person_id = d.id;
        SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO sms_ids
          FROM sms_outbox WHERE person_id = d.id;

        UPDATE driver_ledger       SET person_id = keep_id WHERE person_id = d.id;
        UPDATE driver_platform_id  SET driver_id = keep_id WHERE driver_id = d.id;
        UPDATE driver_ledger_audit SET person_id = keep_id WHERE person_id = d.id;
        UPDATE sms_outbox          SET person_id = keep_id WHERE person_id = d.id;
        IF keep_rule IS NULL AND d.cash_rule IS NOT NULL THEN
          UPDATE driver SET cash_rule = d.cash_rule WHERE id = keep_id;
          keep_rule := d.cash_rule;
        END IF;

        why := format('%s folded into %s (key ''%s''): the operator ruled them one person on '
          || '2026-10-08 ("%s"). Moved %s account(s) and %s ledger entr%s worth %s.',
          coalesce(d.full_name, 'person ' || d.id), coalesce(keep_name, 'person ' || keep_id),
          p->>'k', (SELECT string_agg(w, '"; "') FROM jsonb_array_elements_text(p->'words') w),
          jsonb_array_length(accts), n_entries, CASE WHEN n_entries = 1 THEN 'y' ELSE 'ies' END,
          round(amt, 2));
        INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id, payload)
        VALUES ('operator', 'person_merge', 'accepted', why, keep_id,
                jsonb_build_object(
                  'keep', keep_id, 'drop', d.id, 'by', 'operator', 'why', why,
                  'via', 'sql/schema_v102.sql', 'key', p->>'k', 'ruling', ruling,
                  'accounts_moved', accts,
                  'entries_moved', entries,
                  'moved_amount', round(amt, 2),
                  'audit_rows_moved', audit_ids,
                  'sms_rows_moved', sms_ids,
                  'cash_rule', jsonb_build_object('survivor_after', keep_rule, 'dropped', d.cash_rule),
                  'reversible_by', 'move these entry, audit and sms ids back to the dropped person id '
                    || '(re-created with its old name) and re-attach the accounts listed above'));

        DELETE FROM driver WHERE id = d.id;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'schema_v102: person % (key %) could not be folded into %: %',
          d.id, p->>'k', keep_id, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END
$mig$;
