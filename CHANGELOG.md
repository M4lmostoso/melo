# Changelog

> Melo is a fork of [Velo](https://github.com/avihaymenahem/velo), an open-source desktop email client built with Tauri + React. Velo's original work provided the foundation — multi-account Gmail/IMAP, JWZ threading, rich text composition, smart inbox categories — on top of which Melo has built hundreds of improvements, new features, and its own visual identity. Thanks to Avi Haymenahem and the contributors to the original project.

---

## [0.2.0](https://github.com/M4lmostoso/melo/compare/melo-v0.1.0...melo-v0.2.0) (2026-06-30)


### ⚠ BREAKING CHANGES

* Migration 18 adds 3 new database tables (writing_style_profiles, tasks, task_tags) and 2 new default settings. The migration runner now wraps each migration in a transaction. The taskStore is the 9th Zustand store and is initialized on app startup. These changes require a fresh app restart to run the new migration.

### Features

* accept self-signed certificates for IMAP/SMTP ([#148](https://github.com/M4lmostoso/melo/issues/148)) ([a5f7cec](https://github.com/M4lmostoso/melo/commit/a5f7cec2d8a4bd2701acd96a36fd62c8ac00c93a))
* add "Everything" sync option by disabling date filters in Gmail and IMAP services ([dac86e4](https://github.com/M4lmostoso/melo/commit/dac86e4f65fe77bfabcb986ba97e3a36863fad2e))
* add About page to settings ([fa03431](https://github.com/M4lmostoso/melo/commit/fa03431f091a3f84d78eab1122267c35fdd8c722))
* add account creation flow to settings page and extend section component to support actions ([d1ce51e](https://github.com/M4lmostoso/melo/commit/d1ce51e84126e80b51caf72fcf57a0ce2c5563d2))
* add account-level synchronization status indicators and prune deleted IMAP UIDs during sync ([32fdac0](https://github.com/M4lmostoso/melo/commit/32fdac0dd8520bdb2816b65fa38e281815a2afc0))
* add AI answer panel with citations and update SearchBar to textarea, plus enable manual RAG re-indexing in settings ([a49f5d9](https://github.com/M4lmostoso/melo/commit/a49f5d95837c1bd6e1647d3934ab8e00ec5c6943))
* add AI auto-draft replies with writing style learning and full task manager ([c75dfc5](https://github.com/M4lmostoso/melo/commit/c75dfc5b3cf7b08abc9c8a9c15018dc480413516))
* add AI sidebar to composer with chat interface ([bcf0390](https://github.com/M4lmostoso/melo/commit/bcf0390e4da4571ece5a3546e52106a8909e3a8c))
* add AI smart labels for automatic email labeling ([986a7ae](https://github.com/M4lmostoso/melo/commit/986a7aef3f13171f0a0cebd8f523aa67a7cb34f5))
* add app icon style settings and integrate muted threads with urgency decay logic ([0e8fb96](https://github.com/M4lmostoso/melo/commit/0e8fb964772563bea9132b94c00853e6d0ee4534))
* add attachment library, keyboard shortcut, and update docs ([b69f042](https://github.com/M4lmostoso/melo/commit/b69f042e74b42ba4680ee60730959e7de08e6dc7))
* add auto-update via Tauri updater plugin ([7ac2362](https://github.com/M4lmostoso/melo/commit/7ac2362c3ef1c9e9f628fd2232cd16f8ccfc194b))
* add automated AI-driven email labeling with customizable confidence threshold and per-account settings ([f5b3552](https://github.com/M4lmostoso/melo/commit/f5b35523f057f0f0be50eec7461deba35e30a1bb))
* add automated calendar invite pruning, smart folder, and visual account-based thread indicators ([97a9301](https://github.com/M4lmostoso/melo/commit/97a930189b4341a2dafe925d0d41706dc6ed721d))
* add background reminders for upcoming calendar events and desktop notifications for new emails and snoozed thread returns ([6d3dc15](https://github.com/M4lmostoso/melo/commit/6d3dc15f519ada4d47a381fecb3afcbfcd246098))
* add CalDAV calendar integration for IMAP and standalone accounts ([08e05ff](https://github.com/M4lmostoso/melo/commit/08e05ff571652c73cce6261a3c5f875a6a013e9a)), closes [#113](https://github.com/M4lmostoso/melo/issues/113)
* add ContactChip hover cards, enhance AI urgency prompts with rationales, and support focused contact sidebar navigation ([bcaaec1](https://github.com/M4lmostoso/melo/commit/bcaaec16106ebd09b7deda849aebf57bddb8be7b))
* add conversation history support to AI providers and introduce BlockStyle Tiptap extension for preserved inline styling ([fcac1a7](https://github.com/M4lmostoso/melo/commit/fcac1a7a0ee66b47dc69497ffab9435a9637b47e))
* add drag-and-drop reordering support for mail accounts in settings ([3812f1d](https://github.com/M4lmostoso/melo/commit/3812f1d298b37092d1f2ae83853cb36224b37462))
* add draggable region and disable text selection for empty state views ([b648c84](https://github.com/M4lmostoso/melo/commit/b648c84d03d88939c837f57cc62165f89ae23a16))
* add dynamic app icon theme support based on system appearance settings ([72548db](https://github.com/M4lmostoso/melo/commit/72548dbaefffc2054092b5942ca069caa0d1df7f))
* add dynamic calendar color-coding, improve scrollbar UX, and fix all-day event end-time calculations. ([f89e774](https://github.com/M4lmostoso/melo/commit/f89e774ca287b08bc1516fcf90a4ebbbd5bcb2bd))
* add email-task linking UI and logic, improve thread stats IMAP label handling, and protect against spurious folder purges during IMAP sync. ([c558c80](https://github.com/M4lmostoso/melo/commit/c558c80424a49686a02bd1fdbd5cd6e2b76433f8))
* add empty state illustrations, expand localization, and improve IMAP sync flag tracking ([eafd18b](https://github.com/M4lmostoso/melo/commit/eafd18b76dda543c4e8cf3b1276c666c2e226238))
* add Flatpak and RPM packaging for Linux distribution ([95c1e29](https://github.com/M4lmostoso/melo/commit/95c1e2954a465982c3feec8d90bbe1aee8fb8c86))
* add font size/color/family to composer toolbar ([1d425e7](https://github.com/M4lmostoso/melo/commit/1d425e71924b81ebfa85d67efdb81ebfb1d1b4d9))
* add getThreadIdsForLabel service and integrate into EmailList component ([471c117](https://github.com/M4lmostoso/melo/commit/471c117adb2a62a6948a83f5e8b61596760bdbd5))
* add GitHub Actions CI workflow and document recent feature, security, and stability improvements in CHANGELOG.md ([7aab815](https://github.com/M4lmostoso/melo/commit/7aab815a03d3d503582acc367b44f7fde66dd1e4))
* add GitHub Copilot (GitHub Models) as 5th AI provider ([9b8e162](https://github.com/M4lmostoso/melo/commit/9b8e1628d9cd784bb3e1a5d3a310724e198ce1cd))
* add Gmail label modification and thread trashing support, update delta sync logic, and increase Ollama max tokens ([0721531](https://github.com/M4lmostoso/melo/commit/07215316937febcef693e7a804418bb8e300664b))
* add hierarchical Gmail label creation support and truncate breadcrumb UI in sidebar ([3b447b3](https://github.com/M4lmostoso/melo/commit/3b447b3b2ccf1132b4b713f196ca34f95db7cca1))
* add hierarchical label support via breadcrumbs, prefix filtering, and nested path navigation ([2112c82](https://github.com/M4lmostoso/melo/commit/2112c823556860ac36c41a8b56898c9a7de04e85))
* add Homebrew tap auto-update to release workflow ([4a817b0](https://github.com/M4lmostoso/melo/commit/4a817b0dba3bba3b8d4650e3c1a3b57a9f0a72f0))
* add IMAP account configuration editor and improve IMAP sync reliability with batch retries and duplicate label handling ([6acaa8f](https://github.com/M4lmostoso/melo/commit/6acaa8fb74ce950a7b60727ad3da60708b8f64d5))
* add IMAP folder-to-label mapping system with urgency adjustment and UI indicators. ([53946b8](https://github.com/M4lmostoso/melo/commit/53946b8ec3967d2e2b5f7da4898d5e8947922124))
* add Inter font support, improve IMAP deletion reliability, and fix draft management state persistence. ([1aae94e](https://github.com/M4lmostoso/melo/commit/1aae94e4f5e3e0896f445f9489da69b9bef68e15))
* add isSending state to composer store and update UI to handle loading states during email delivery ([2d2ad01](https://github.com/M4lmostoso/melo/commit/2d2ad016ffc022a1c3802c2b1cecddd11877098e))
* add local AI support via Ollama and LMStudio ([1cee002](https://github.com/M4lmostoso/melo/commit/1cee00291df37c46ba2d46a95346152a6ac7dc1f)), closes [#98](https://github.com/M4lmostoso/melo/issues/98)
* add manual mail sync button to macOS sidebar and enable window dragging in action bar ([ce44904](https://github.com/M4lmostoso/melo/commit/ce449047dfd7c55c99aeab281ec7093855875047))
* add meeting join buttons to calendar views and event details with URL parsing utilities ([1aae2b5](https://github.com/M4lmostoso/melo/commit/1aae2b528f61fef94f5180ca04a577694923d8b7))
* add Microsoft OAuth2 support for Outlook/Hotmail/Live accounts ([019a5e2](https://github.com/M4lmostoso/melo/commit/019a5e241dc558d6eb384efc5b6e9880643d7383))
* add model selection dropdowns for AI providers ([#158](https://github.com/M4lmostoso/melo/issues/158)) ([74244ca](https://github.com/M4lmostoso/melo/commit/74244caf5c0072272abad7c3e7481eb1674eb2ef))
* add Move to Folder/Label shortcut (V key) ([751aeaa](https://github.com/M4lmostoso/melo/commit/751aeaa4b98002ebdc99156ce76a256786ccf042))
* add multi-account support with per-account labeling, customized UI components, and global unread tracking ([a395167](https://github.com/M4lmostoso/melo/commit/a39516721ab67040c893d226a17a559a75d8df13))
* add multi-language support for forwarded email headers and reply attribution lines ([e2c9a1e](https://github.com/M4lmostoso/melo/commit/e2c9a1e2196510d0cd16b4d7187242d0453b5537))
* add office document preview support and update trash handling in thread view ([4984aee](https://github.com/M4lmostoso/melo/commit/4984aee564eee3cafbdfb5f56f3704b4be8ec1d1))
* add optional label field to accounts for custom display identification ([07be197](https://github.com/M4lmostoso/melo/commit/07be1970ceb8cdd6e36d3c9c6a062494fa3e515f))
* add Outgoing queue view for failed/retryable sends and enhance AI urgency decay logic with reply context ([43b2695](https://github.com/M4lmostoso/melo/commit/43b2695d2f35ac63a223d7eed7324d445a120220))
* add Outgoing sidebar section with persistent and memory-based email tracking ([6957056](https://github.com/M4lmostoso/melo/commit/69570561638f481eed998058756c57ac2b31b549))
* add PEC (certified email) support with automated receipt folder management and filtering ([8d7df66](https://github.com/M4lmostoso/melo/commit/8d7df66f68a14aee4aa62b82feca0c2ab24274f0))
* add per-message action support, sync threads on reply, and localize sidebar labels ([0837118](https://github.com/M4lmostoso/melo/commit/08371187f6d72cfdbf37f405ea99fe148c7a609e))
* add release-please workflow for automated versioning and changelog management ([acf1c0d](https://github.com/M4lmostoso/melo/commit/acf1c0df3e0a9f9b33835485af8587b09faecaf6))
* add scheduled emails view with panel for management and tracking ([de4e8f1](https://github.com/M4lmostoso/melo/commit/de4e8f1353bee00366fa65be104a92b465dfd224))
* add sidebar nav item reordering and visibility customization ([3f96837](https://github.com/M4lmostoso/melo/commit/3f96837dfeaf65647889633d297766b6e5be079c))
* add standalone workflow to manually sync homebrew tap ([5a33e67](https://github.com/M4lmostoso/melo/commit/5a33e6707175bfa13a443c2e2489e6f40996ee7b))
* add support for editing queued emails and display in-flight outgoing items in the queue view ([f840c18](https://github.com/M4lmostoso/melo/commit/f840c18da454cf81befa9ae54423fb59df75cf2d))
* add support for iCloud Mail accounts with dedicated connection rate-limiting and app-specific password warnings ([947cd44](https://github.com/M4lmostoso/melo/commit/947cd44b22617ef8dde51744e3d29690656cffdf))
* add support for IMAP attachments by introducing imap_part_id and implementing robust base64 normalization for inline images. ([62d473a](https://github.com/M4lmostoso/melo/commit/62d473a61a7c66cbbaedc92b857a295ef7e9d895))
* add support for parsing and responding to calendar invite attachments ([25d1107](https://github.com/M4lmostoso/melo/commit/25d11077c3b076d0959a1f8da6ac4b0450d7beff))
* add support for resolving inline CID images in email bodies using blob URLs ([1d57aa3](https://github.com/M4lmostoso/melo/commit/1d57aa3e75bcd70b1e986f291783bf2c60e99fba))
* add support for unified calendar view across multiple accounts in CalendarPage and CalendarList ([6b3cf71](https://github.com/M4lmostoso/melo/commit/6b3cf711915181b25e4d6cbe7e9d85be6c9a4dff))
* add support to dynamically fetch and inject missing threads into the store upon citation click ([e1a8bed](https://github.com/M4lmostoso/melo/commit/e1a8bed93ab3273abe9519c9b96b66570c97292d))
* add theme-aware accent colors to forwarded messages and improve quote/header parsing reliability ([b4fd363](https://github.com/M4lmostoso/melo/commit/b4fd36366ba5e61d30ddf2d870c2a7bd1c4da7db))
* add tray badge support and remove unused app icon style state ([3d47d5d](https://github.com/M4lmostoso/melo/commit/3d47d5dd19860e9c6c7acb3520204cd0a127262d))
* add unified folder support for cross-account labels and update account settings UI to use single-save flow ([fd31117](https://github.com/M4lmostoso/melo/commit/fd3111729ea3f2222d1e7836971c442198d0f73d))
* add unread counts to sidebar folders and labels ([ac12a5f](https://github.com/M4lmostoso/melo/commit/ac12a5fe4d150e067956032989874c4971d67de0))
* add unread message counts to thread state and UI, and improve thread synchronization and categorization logic ([f0d5e9a](https://github.com/M4lmostoso/melo/commit/f0d5e9ab6bfad3d11fa28095758ec0d79c338656))
* add View Source option to message context menu ([c657b0f](https://github.com/M4lmostoso/melo/commit/c657b0f798d70bda0436acbd0ea435afd3f84b63))
* add visual indicator for unread messages in MessageItem ([ecb3d5b](https://github.com/M4lmostoso/melo/commit/ecb3d5baf8ccd20093d4da8a518aacc3655fb1a6))
* auto-advance to next thread after removal actions ([520ea01](https://github.com/M4lmostoso/melo/commit/520ea01ab78bbd7a8cc8fa019246fe4a7d181034))
* chunked IMAP sync with lightweight UID search and batched transactions ([7440215](https://github.com/M4lmostoso/melo/commit/7440215fe1bf923afc666486ec2c999ed1e5c266))
* **composer:** add account switcher to composer modal ([fd45dfe](https://github.com/M4lmostoso/melo/commit/fd45dfe00af0e07c76188b206e7cb0653eac0c33))
* consolidate release pipeline — packaging and homebrew on release only ([7e4ac8c](https://github.com/M4lmostoso/melo/commit/7e4ac8cc40da62c8d23716b4f5c21fea27e263c3))
* **contacts:** add Google Contacts sync ([dab28d9](https://github.com/M4lmostoso/melo/commit/dab28d968cf90b8617438fcd74fce1fedb42223a))
* context-aware account selection for composer opening via search and keyboard shortcuts ([6a58131](https://github.com/M4lmostoso/melo/commit/6a58131a7c60cbeb63f3b683ed37a3ea867de2c1))
* display attachment icon on message items and refine attachment filtering logic to exclude inline and CID-referenced items ([c8ba925](https://github.com/M4lmostoso/melo/commit/c8ba9253dbf1f462b0286948cb5caac870b20265))
* enable drag-and-drop reordering of recipient addresses between composer fields and update search bar to use contact store names ([4026c00](https://github.com/M4lmostoso/melo/commit/4026c004cd4f104567a9d564d2552b1983bd78f9))
* enable fetching threads directly from DB in ReadingPane and improve citation linking in AnswerPanel ([863322e](https://github.com/M4lmostoso/melo/commit/863322ee56c5ea2374354da63f40d047951166b9))
* enable unified calendar view to aggregate events and calendars across all accounts ([c8181c0](https://github.com/M4lmostoso/melo/commit/c8181c0f66b6ab489c60f8a04ad7eec350fe9094))
* enable window dragging by adding data-tauri-drag-region to primary layout containers ([1c616c1](https://github.com/M4lmostoso/melo/commit/1c616c1a107e069ec6fd6a4cfe9c2307e7fb175c))
* enable window dragging for fullpage composer and increase default window width ([97f9104](https://github.com/M4lmostoso/melo/commit/97f9104bf8a234ed325da12c2d58ebdf2fc70eab))
* enhance email printing to support message threading, signatures, and improved document styling ([94dc637](https://github.com/M4lmostoso/melo/commit/94dc63741feb2bf6da72831faccc785cc44c128e))
* enhance sender and recipient display logic in threads with database-level filtering and UI updates ([67cb717](https://github.com/M4lmostoso/melo/commit/67cb7176d2194ec1d9e464fcd56de3b8e332a6f0))
* enhance urgency scoring with legal sender detection, follow-up identification, and email disclaimer sanitization ([ab662f4](https://github.com/M4lmostoso/melo/commit/ab662f4dc6fd096e90ff88edd20cf551e3e6fe66))
* ensure composer opens with current account context and improve reply message header resolution ([167cc6d](https://github.com/M4lmostoso/melo/commit/167cc6d48c421a27faddcf325ea3085afe275a87))
* **i18n:** bootstrap i18n infrastructure and replace strings in settings tabs + accounts ([7613b8b](https://github.com/M4lmostoso/melo/commit/7613b8bd4ebefb8b7b9ab1e1e9e733b671a39247))
* **i18n:** complete i18n refactor — replace all hardcoded strings with t() calls ([34e4ba6](https://github.com/M4lmostoso/melo/commit/34e4ba6714edc19026585e8b845bb43e45038bda))
* **i18n:** merge worktree i18n changes + resolve conflicts ([1e75ce3](https://github.com/M4lmostoso/melo/commit/1e75ce3f38c18ec82fca63c0ef182a1c84b1721c))
* **i18n:** replace hardcoded strings with t() calls in 71 components (batch 1) ([c034326](https://github.com/M4lmostoso/melo/commit/c034326f41f3f457bdd5103e4ca07848d6b0b1c5))
* implement aggregated RAG indexing progress and auto-resume backfill after sync ([b4d8401](https://github.com/M4lmostoso/melo/commit/b4d8401c8049b2e45b857e51f0ee6baebb72c1a1))
* implement AI phishing arbitration and improve thread urgency decay logic ([a8d66e8](https://github.com/M4lmostoso/melo/commit/a8d66e84f854e9c3e545a1bbedbb3ec804a43bb5))
* implement AI-driven email urgency decay, reputation-based scoring, and heat extinction functionality ([765a576](https://github.com/M4lmostoso/melo/commit/765a5762886d1a589eced1dcbc289ba3f20a55ed))
* implement AI-driven urgency scoring with temporal decay and reset existing thread scores for re-evaluation. ([aa368a8](https://github.com/M4lmostoso/melo/commit/aa368a8041fbcfade4d175bf4b2cae75905d3e4d))
* implement auto-scrolling to current time and add visual time indicator to WeekView while updating EventCard to use line-clamp-2 ([35a0017](https://github.com/M4lmostoso/melo/commit/35a0017ed8df4ffa1faeebc6d2106be40385fcd6))
* implement automated draft cleanup for successful retried sendMessage operations ([2d6a2e3](https://github.com/M4lmostoso/melo/commit/2d6a2e34b1fbf099c3bda39bd1fa3496e554b1b6))
* implement batch attachment downloads with de-duplication and progress tracking ([007d900](https://github.com/M4lmostoso/melo/commit/007d900005c1715fc0bf2d48a2af1c6ebbe63d2d))
* implement batched database queries and optimize search flow with direct result hydration in thread store ([f647f32](https://github.com/M4lmostoso/melo/commit/f647f32854204db1240b7a1828817509d6fc8ab5))
* implement body caching and backpressure via semaphores to optimize message synchronization performance ([38f0599](https://github.com/M4lmostoso/melo/commit/38f05998265c2da9e39926479014fd72f318a5fe))
* implement CalDAV PUT/update logic, sync IMAP/CalDAV credentials, and add calendar reminder background checks. ([8a6ff5d](https://github.com/M4lmostoso/melo/commit/8a6ff5de4c41d46558b2c047a735341943407e17))
* implement CalDAV synchronization and calendar metadata customization support ([3b90ef4](https://github.com/M4lmostoso/melo/commit/3b90ef4fa9a8909f5d9a450f1ef79dd6f008bc07))
* implement calendar sync reconciliation, refactor sidebar navigation components, and add core database migration support. ([19848c8](https://github.com/M4lmostoso/melo/commit/19848c8badd665244abad56a1ee9224fd24c2161))
* implement client-side RRULE expansion for CalDAV providers lacking native support ([542b0dd](https://github.com/M4lmostoso/melo/commit/542b0ddb4522cd43fb8cd8b7a0fd75b7aceb1ca1))
* implement configurable AI personality via SOUL.md with settings UI and file monitoring ([efe8b00](https://github.com/M4lmostoso/melo/commit/efe8b00f54548d7204e6aa26db59449eca54234c))
* implement contact autocomplete suggestions in search bar and update query sorting ([6842852](https://github.com/M4lmostoso/melo/commit/68428527043c411b90b2319da8109be417358b2c))
* implement contact display name caching store and integrate into UI components ([9313f47](https://github.com/M4lmostoso/melo/commit/9313f4757550c5c218ecaba3aef718ce9ac67d54))
* implement cross-account folder moving and enhance sidebar drag-and-drop hit detection ([dff21ce](https://github.com/M4lmostoso/melo/commit/dff21ce60aade1aab159dd112ef218f2a9efdd9c))
* implement cross-account thread moving and add no-label filter support ([95cb97b](https://github.com/M4lmostoso/melo/commit/95cb97bfaff044d46a33e23334114e8224052f13))
* implement dynamic task retention settings and add inline task editing capabilities ([bf3b406](https://github.com/M4lmostoso/melo/commit/bf3b4067c6dd1134481754b7b980452610c43d07))
* implement fixed light/dark tray icons and suppress urgency scoring for non-primary threads ([167d642](https://github.com/M4lmostoso/melo/commit/167d642b97d50d1a397d84b85141534c8a1ec659))
* implement hybrid FTS and vector search with RRF in Rust and synchronize thread message selection ([1e1ad1d](https://github.com/M4lmostoso/melo/commit/1e1ad1d8548a97ba51700d33ddca9d9b07ebea27))
* implement IMAP folder management UI with create, rename, and delete capabilities ([981d696](https://github.com/M4lmostoso/melo/commit/981d696480dda0e447b8da8da3beaa851906b14b))
* implement IMAP IDLE support with background synchronization and UI management tabs. ([799ff79](https://github.com/M4lmostoso/melo/commit/799ff79a527ff2d8cd093777d0da744a514ada5a))
* implement IMAP message deduplication, external deletion reconciliation, and virtual folder filtering ([b1601b7](https://github.com/M4lmostoso/melo/commit/b1601b7480ffe2445fe5f00591fe94c191b88be9))
* implement interactive month picker in calendar toolbar and update event card UI styles ([ff5c6e9](https://github.com/M4lmostoso/melo/commit/ff5c6e97361ba5bcd987871965523b49d9f79e30))
* implement local file preview modal, refactor calendar day view layout, and add forwarded message utility. ([f96be08](https://github.com/M4lmostoso/melo/commit/f96be08652104f07f63f83bc2ce271b39f3575c1))
* implement multi-select hook for attachments with drag-and-drop, native app integration, and UI selection state. ([c235c28](https://github.com/M4lmostoso/melo/commit/c235c28f0f725aa07dad14ae14500345ebb0d07e))
* implement native macOS dock icon updates using cocoa bindings ([89fc8cd](https://github.com/M4lmostoso/melo/commit/89fc8cd7fd22e6eca84e2156e8b23225fb257d58))
* implement native macOS traffic light window controls in sidebar ([e851fac](https://github.com/M4lmostoso/melo/commit/e851facad6601c7a5b0322398a7f4d690490c014))
* implement nonce-based message verification to resolve WKWebView iframe communication issues and fix layout height calculation ([4fd7f06](https://github.com/M4lmostoso/melo/commit/4fd7f0698b74ca8b99f037c0b1ea0853d1a4218a))
* implement pending label assignments for cross-account IMAP moves and add attachment forwarding support ([e8b58aa](https://github.com/M4lmostoso/melo/commit/e8b58aa622ef87d5ef26b78847e2c1f3e7d77d5f))
* implement periodic task badge refreshing and trigger updates on task mutations ([f2a2dfc](https://github.com/M4lmostoso/melo/commit/f2a2dfc1a8506361b58d22e641984a669ccf5248))
* implement pre-send validation to detect missing subjects and forgotten attachments ([7500825](https://github.com/M4lmostoso/melo/commit/7500825628beec2c87b1d1718c1ca66035d5f2ec))
* implement raw TCP attachment downloads with progress reporting and exclude SENT messages from inbox threads ([13a08d1](https://github.com/M4lmostoso/melo/commit/13a08d1589ee868bd54d85b439bcd8e5f12cc62c))
* implement raw TCP attachment fetching to bypass IMAP parser hangs and add fallback attachment discovery logic for legacy messages. ([8c401ae](https://github.com/M4lmostoso/melo/commit/8c401ae5fe41b0cac7a82af08f2a5de0cdcb4cb7))
* implement real-time sidebar unread badges and fix test suite regressions ([5cc068a](https://github.com/M4lmostoso/melo/commit/5cc068a14ea4552331b48e821a0c877222ea3b3a))
* implement reconcileFragmentedThreads to unify split conversation threads during imapSync ([02ccefd](https://github.com/M4lmostoso/melo/commit/02ccefd38e4f4521fc43601e76f3c0f268d4e128))
* implement recurring event deletion and filter declined events in calendar queries ([22c75a6](https://github.com/M4lmostoso/melo/commit/22c75a649bdf78b5607e9d4ae382afe63a803092))
* implement recursive HTML body extraction for multipart email messages ([75c665d](https://github.com/M4lmostoso/melo/commit/75c665d9f92c2134e46b02be3e462eb5bd41668b))
* implement RFC 2822 References header support in composer and reply flows ([fa89fbc](https://github.com/M4lmostoso/melo/commit/fa89fbc9056c1c685cb99313d8ae74e6ce060319))
* implement robust recipient label resolution with priority for stored contacts and add sync for display-name cache updates ([4d0bfd3](https://github.com/M4lmostoso/melo/commit/4d0bfd3be2e4f1889a16889b4a4df7f970b223c2))
* implement scheduled email management with list, detail views, and state handling ([52dd9b2](https://github.com/M4lmostoso/melo/commit/52dd9b27a357655b9d2a69125604be320b180432))
* implement scrollTracker to prevent accidental swipe gestures during list scrolling and improve gesture reliability. ([102f10b](https://github.com/M4lmostoso/melo/commit/102f10b008ccd9320718d057751842a3d4b0fa12))
* implement semantic result merging for cited threads and update AI identity guidelines in SOUL.md ([c4bb0d7](https://github.com/M4lmostoso/melo/commit/c4bb0d7173ca8fd73bee930d7714df9c2cceeb8b))
* implement sound effects system with customizable user settings and notification triggers ([6aff5df](https://github.com/M4lmostoso/melo/commit/6aff5dfa0f895b405326ab574128675d0f25e302))
* implement stale state guarding for thread loads, granular message read status updates, and improved keyboard navigation in composer. ([8ea66ab](https://github.com/M4lmostoso/melo/commit/8ea66ab40987509446133a5a8155f441c30dfb45))
* implement subject-based thread merging for replies and forwards lacking headers ([38c0e84](https://github.com/M4lmostoso/melo/commit/38c0e84eb75d354289863d2d41a5982cf053b3c5))
* implement swipe-to-action functionality for email threads with pointer and trackpad support ([3524307](https://github.com/M4lmostoso/melo/commit/352430738f182df70935ae2da8d14cf8bda0d276))
* implement synchronous IMAP draft tombstones to ensure reliable local deletion during composer closure. ([673dab2](https://github.com/M4lmostoso/melo/commit/673dab22edab0095342ce83fc7086806b4ccf958))
* implement thread urgency scoring pipeline with automatic backfill and update Gmail provider to use native trashThread support. ([5838f36](https://github.com/M4lmostoso/melo/commit/5838f3647cccc552bace92098c6a8efecfe0e7ed))
* implement tombstone table to prevent re-import of deleted IMAP messages during sync ([476e03e](https://github.com/M4lmostoso/melo/commit/476e03e237d7f65322514f6be29a472308b0d5ca))
* implement unified attachment view with cross-account support and source labeling ([c70d371](https://github.com/M4lmostoso/melo/commit/c70d371611ad9094cb12359f764d08bd5cc8c9b4))
* implement unified cross-account search for smart folders, update account color palette, and adjust signature dropdown positioning ([f58b5ef](https://github.com/M4lmostoso/melo/commit/f58b5ef1c331a58d6bb2b62e4594ba45edcbfea5))
* implement unified inbox and folder views, add global account settings, and clean up UI component properties ([6a66954](https://github.com/M4lmostoso/melo/commit/6a66954bfd533116c0afb02549ad7712d0187427))
* improve calendar RSVP reliability by echoing original event properties and adding UTF-8-safe base64 encoding for ICS attachments. ([e45ca8a](https://github.com/M4lmostoso/melo/commit/e45ca8ae5db4d8ddf61d1bf622eec228ba4ecd78))
* improve CID resolution and attachment caching with robust memory management and direct Rust-side processing ([6765e27](https://github.com/M4lmostoso/melo/commit/6765e276c46d05780269ed5977e95a55b488ae27))
* improve date handling, UI animations, unread badge styling, and email rendering consistency. ([3f88342](https://github.com/M4lmostoso/melo/commit/3f88342c2aa08a5f4b3ef1a64f2b699abf26a51b))
* improve email parsing with mojibake correction, robust attribution matching, and improved reply/forward quote collapsing. ([4c66922](https://github.com/M4lmostoso/melo/commit/4c66922bfe30633e7a70579cd469a55fe177abe8))
* improve IMAP reliability and SQLite performance ([b807f0d](https://github.com/M4lmostoso/melo/commit/b807f0d2c814d08423969cfa1c4dabaeb25408cc))
* improve IMAP sync reliability and composer pop-out UI ([a394be4](https://github.com/M4lmostoso/melo/commit/a394be46d678cbc82a6e909e9a75a5c91643f1e0))
* improve keyboard navigation and disable spellcheck across search inputs, and prevent text selection in thread lists ([c917abb](https://github.com/M4lmostoso/melo/commit/c917abb49d6beeb6886e3085e1e6bc2df1c73dc0))
* increase default window size and improve attachment download filename resolution with mime-type support ([87ded72](https://github.com/M4lmostoso/melo/commit/87ded721c92b5134a91821fd242fd751df8d388b))
* inject target language into task extraction prompt and bypass default language logic ([946138c](https://github.com/M4lmostoso/melo/commit/946138c9777112c45b60fbf486fd72def99df1b1))
* integrate smart folders into global navigation with account-specific active state and border styling ([06be415](https://github.com/M4lmostoso/melo/commit/06be415418b5f7eadd52bef7cf2b5eaa06f001ab))
* integrate thread context and past user replies into AI composer for improved personalization ([3bb114a](https://github.com/M4lmostoso/melo/commit/3bb114acdb0395579b3f22d55261b79de746a09c))
* introduce IMAP session pool and frontend concurrency limits to optimize attachment fetching and database performance ([0dc5f94](https://github.com/M4lmostoso/melo/commit/0dc5f94dd3fff3542dbbc49d30c365ef3290bcfe))
* introduce TasksDayPanel for weekly task scheduling and update thread recipient rendering ([2af1413](https://github.com/M4lmostoso/melo/commit/2af141343048455ad5524deefe3d9c1d7df6956d))
* localize sidebar smart folders, exclude inline images from attachment search, and fix thread view account resolution for global/unified views ([ec4f411](https://github.com/M4lmostoso/melo/commit/ec4f411d09ff017e4a735691b65c5d1ed1eb894a))
* localize UI components, expand shortcut key mappings, and update unread thread consistency logic ([1ade2e8](https://github.com/M4lmostoso/melo/commit/1ade2e8615e8fa7ea26b1b5d2c9a12e5a2344088))
* migrate draft persistence to SQLite for cross-window availability and trigger auto-save on window close ([70dede4](https://github.com/M4lmostoso/melo/commit/70dede4e2de44d491b557f063ec66c0734b0a3e3))
* **nav:** add arrow key navigation between messages in thread view ([efd213d](https://github.com/M4lmostoso/melo/commit/efd213d2f0420852be2432e7ef09a1c12231f110))
* **nav:** add arrow key navigation in email list and thread view ([e87c712](https://github.com/M4lmostoso/melo/commit/e87c712a284cee6918f21042764ca90119e8cbb1))
* **nav:** add arrow key navigation in email list with auto-scroll ([9f4b0d8](https://github.com/M4lmostoso/melo/commit/9f4b0d826100492dc781bab6c48b4e0e5ba191af))
* new function "delete single message" and small fix ([0349017](https://github.com/M4lmostoso/melo/commit/034901796ac72b2000ca8602a14b19f880f1612e))
* optimize IMAP delta sync with single-connection batch check ([0a62b73](https://github.com/M4lmostoso/melo/commit/0a62b7363c6c7d34592781a711eb8695b8e5ed52))
* overhaul color palette with refined theme definitions and updated global styles ([2169891](https://github.com/M4lmostoso/melo/commit/2169891912d1b10256af96f4fb489f8182d7e81b))
* overhaul scheduled email list with context menu support, multi-action capabilities, and improved UI styling. ([a2e3060](https://github.com/M4lmostoso/melo/commit/a2e3060b4455019556ae67f287a2d6e6d6d24e66))
* parallelize Gmail sync and add 429 rate limit retry ([ff3580b](https://github.com/M4lmostoso/melo/commit/ff3580b29807c844a81cb79586168700c84c1dc3))
* pass releaseId from release-please to tauri-action ([9587dfd](https://github.com/M4lmostoso/melo/commit/9587dfdd1eae8d2b3364c93ddb07533087246cd9))
* prioritize new account sync to eliminate 20-30s delay ([49bce0f](https://github.com/M4lmostoso/melo/commit/49bce0fc8227d75923642cef26700c13504ee046))
* rebrand to Melo, update application icons, redesign splashscreen, and fix database schema FK mismatch ([fd15e4b](https://github.com/M4lmostoso/melo/commit/fd15e4b30ecf906f5e73a8c769f832b15510678f))
* refactor iframe link handling to use parent-context click listeners and enable composer integration, alongside Tauri window destroy improvements. ([7ae6c70](https://github.com/M4lmostoso/melo/commit/7ae6c705926de1770e3e2ebb787f779e8f7ac638))
* rename app to Melo and add auto-hiding scrollbars to email list and sidebar components ([51d0bec](https://github.com/M4lmostoso/melo/commit/51d0bec1022b539d710eeaf91915e64e86d49886))
* replace inline Gmail account editing with dedicated EditGmailAccount component and remove legacy API setting fields ([7c37be9](https://github.com/M4lmostoso/melo/commit/7c37be98db11bdf0f53a73039f6d1966d55419be))
* replace tray title badge with dynamic image rendering using the image crate ([0de5dce](https://github.com/M4lmostoso/melo/commit/0de5dced31266015d1c35ef3613cec5518ffd1b9))
* set dynamic document title during email print process to improve document naming ([bb78718](https://github.com/M4lmostoso/melo/commit/bb78718f5f5ec02b2e3ace5df4346b9fb964cd42))
* **settings:** add composer default font family and size in composing style section ([f99d5a9](https://github.com/M4lmostoso/melo/commit/f99d5a9a4fb968c887997607eaa1379070f9093e))
* **signatures:** add HTML source editor toggle and sanitize signature output ([e1ca851](https://github.com/M4lmostoso/melo/commit/e1ca8512dc5f54278d64cda0f1fc8721f97a525d)), closes [#99](https://github.com/M4lmostoso/melo/issues/99)
* **signatures:** cross-account signature sharing with per-account activation ([f01dd25](https://github.com/M4lmostoso/melo/commit/f01dd25c538e15a6bd23bfad6d02ab1d0d2efa61))
* store detailed sender contact info in threads and parse names in UI for contact lookup ([0a77d9e](https://github.com/M4lmostoso/melo/commit/0a77d9efe3240c2d097bdc20739094fdc770c210))
* strip console.log and console.debug from production builds in vite.config.ts ([1a95060](https://github.com/M4lmostoso/melo/commit/1a950609d274f4248ec661723022973e036fa43b))
* support dynamic event colors in calendar views and localize calendar headers and titles ([58c6604](https://github.com/M4lmostoso/melo/commit/58c6604fb0f3a4411aadef94093cfd507aacda62))
* support small inline attachments by parsing parts with body.data and implementing a sentinel-based re-fetch mechanism ([5538902](https://github.com/M4lmostoso/melo/commit/55389029a34d6a524e7b5cabf324e0aae22f34cd))
* support unified inbox mode for tasks and update route navigation mapping ([d4d0687](https://github.com/M4lmostoso/melo/commit/d4d06875b0138f2059bef2d0d1a46f500fa13621))
* **sync:** add per-folder sync via F5 shortcut and sidebar context menu ([d11c642](https://github.com/M4lmostoso/melo/commit/d11c642013ed538aaad67f56158e6d9ba37695e9)), closes [#101](https://github.com/M4lmostoso/melo/issues/101)
* synchronize email scheduling across windows using Tauri events and enable multi-account bulk spam/trash actions ([b9ec33a](https://github.com/M4lmostoso/melo/commit/b9ec33a5a61effcb62f784aa6a9cb3db4fcbcfa8))
* **theme:** Refactor dark mode backgrounds and colors to match Zed/Catppuccin Mocha palette ([44f48aa](https://github.com/M4lmostoso/melo/commit/44f48aa6ac2038352fc96d02246ce0a256d860e9))
* track imap folder/uid for sent messages, add external sender support to threads, and implement optimized seen status checking ([f84411f](https://github.com/M4lmostoso/melo/commit/f84411f7868ed49a6d7cf798d8ed944d9171a7b2))
* **ui:** highlight spam threads with dimmed red background ([5766ecb](https://github.com/M4lmostoso/melo/commit/5766ecbc72ea5e121c486d2f21fd7a40a3cd2179))
* update active account when navigating to a task thread ([2c3a55d](https://github.com/M4lmostoso/melo/commit/2c3a55de576f1a2a4551d4cb21a8745e961e2b8d))
* update contact sidebar based on selected message sender ([19e6165](https://github.com/M4lmostoso/melo/commit/19e6165190814f80ffe1cd4871572e3b79baf0e0))
* update drafts view to list individual draft messages instead of threads for better management ([b97fc70](https://github.com/M4lmostoso/melo/commit/b97fc7010887a51613304041de335dd335e54b55))
* update tray badge count on email state changes and remove unused icon asset ([eb45f71](https://github.com/M4lmostoso/melo/commit/eb45f71d3463e7b287d2907e29d65a159436ea5e))


### Bug Fixes

* add --repo flag to gh release upload in SRPM job ([5b863c0](https://github.com/M4lmostoso/melo/commit/5b863c0048a49635b560d921dacbc04ef96b6a15))
* add appdata read/write permissions for Tauri FS baseDir operations ([f9750de](https://github.com/M4lmostoso/melo/commit/f9750de942535e3c245fcfd86b034446bfb37233))
* add Escape key to close inline reply editor ([386b403](https://github.com/M4lmostoso/melo/commit/386b40303e5dece542eb2617e485e352cc3f5c07))
* add missing path separator in attachment cache directory ([de4355b](https://github.com/M4lmostoso/melo/commit/de4355b799abf316cb4ee729d22c6f03138174f2))
* add reduce motion setting to prevent animated background strobe on some Windows GPUs ([981f2b5](https://github.com/M4lmostoso/melo/commit/981f2b51aabf95e7335f08ef8ce7c0f4ec9b0ca7)), closes [#156](https://github.com/M4lmostoso/melo/issues/156)
* add repair logic to re-run migration 26 if deleted_imap_uids table is missing ([e0282ba](https://github.com/M4lmostoso/melo/commit/e0282ba05465038cc491cfd401948bda8a3a0782))
* add TCP timeouts and keepalive to IMAP client ([#147](https://github.com/M4lmostoso/melo/issues/147)) ([a77b474](https://github.com/M4lmostoso/melo/commit/a77b474bcc3f59abf49e5c67665cffdb7459058d))
* adjust CSP for inline scripts and improve iframe height calculation stability in EmailRenderer ([a70e331](https://github.com/M4lmostoso/melo/commit/a70e33119bc30770d871e02f5934540f05df6871))
* adjust print layout margins and increase cleanup timeout to support PDF generation ([da6519c](https://github.com/M4lmostoso/melo/commit/da6519c80e95753e684ecd76c5e6e3b6a908adfb))
* align release pipeline version sync for SRPM and Homebrew ([ebf21ff](https://github.com/M4lmostoso/melo/commit/ebf21ffe3f22bbbaeeb9d8e598df876f23c8c34f))
* align test files — remove stale mocks, add cleanup, fix brittle assertions ([4acf9e3](https://github.com/M4lmostoso/melo/commit/4acf9e3343e377a989f80bc26bd650f988e5bf47))
* allow homebrew tap update on workflow_dispatch triggers ([c31ddc8](https://github.com/M4lmostoso/melo/commit/c31ddc86c022005d1aa02ea9f6e828a39e2bff46))
* allow optional space after colon in search operators ([d1e9495](https://github.com/M4lmostoso/melo/commit/d1e9495ec5efa247406941d0b5ebfec55d699927))
* attachments not showing in attachment list ([fdf8c75](https://github.com/M4lmostoso/melo/commit/fdf8c75ed5d42e29fdd90e96c88b2b33a90d48b4))
* **attachments:** use EmailProvider for IMAP attachment preview and download ([228ca5e](https://github.com/M4lmostoso/melo/commit/228ca5e86be56e080c3a109acbdd07e63c63bdd4)), closes [#100](https://github.com/M4lmostoso/melo/issues/100)
* bind OAuth server to 127.0.0.1 instead of localhost ([ec47a7a](https://github.com/M4lmostoso/melo/commit/ec47a7a5095bb5deffc24e9b6812e39107508dbe))
* call sep() as function, not use as string ([b65888b](https://github.com/M4lmostoso/melo/commit/b65888b70578c767a330ec13087c38f66880bda5))
* **ci:** auto-sync Homebrew tap when workflow files change ([2958a35](https://github.com/M4lmostoso/melo/commit/2958a35a2ac01c29bdf5f3e3ec9c359a5bf131dd))
* **ci:** fix Homebrew cask 404 and deprecation warning ([b39d402](https://github.com/M4lmostoso/melo/commit/b39d402bd36f3415c25ecb160dc4c5ec92d67195))
* **ci:** fix version parsing in standalone update-homebrew workflow ([41b3390](https://github.com/M4lmostoso/melo/commit/41b3390652b6f2055c7cb523a2153d6d4359b069))
* **ci:** remove invalid makeLatest input and fix Homebrew update skip ([236e81b](https://github.com/M4lmostoso/melo/commit/236e81ba33b95a134bd7852840809039c24561c0))
* **ci:** verify DMG exists before updating Homebrew cask ([2cdc3d2](https://github.com/M4lmostoso/melo/commit/2cdc3d2fd3e54f5c5dcb99d1c8fe92fe59305861))
* clean up spurious DRAFT labels and restrict unread counts to exclude DRAFT/TRASH threads ([10616d6](https://github.com/M4lmostoso/melo/commit/10616d65e368a9856ae8951c55f41248943cc37f))
* clear composer state on fresh compose and improve AI sidebar ([f26e925](https://github.com/M4lmostoso/melo/commit/f26e9252f51ac47be3dfe5cf9314b39336403971))
* Composer.tsx for draftAutoUpdate ([743f71f](https://github.com/M4lmostoso/melo/commit/743f71fcc6022ce7c776d3a4bee9fbe35a6ab23a))
* **composer:** place signature before quoted text in reply/forward ([97d9901](https://github.com/M4lmostoso/melo/commit/97d99018dc7ca889036339fe09be1dc75f689669))
* **composer:** position signature below body text instead of right side ([2324cd7](https://github.com/M4lmostoso/melo/commit/2324cd7e0559e0b840fb3700156283f98ca3440f))
* create placeholder thread before message insert during IMAP sync ([6c2d013](https://github.com/M4lmostoso/melo/commit/6c2d0135a6b3683dfbce4075a032b9df12ed699a)), closes [#89](https://github.com/M4lmostoso/melo/issues/89)
* decode IMAP folder names from modified UTF-7 and use real UIDs for sync ([19a919e](https://github.com/M4lmostoso/melo/commit/19a919eece270efaa0751e8d74b42dca6e6f4f54))
* **drafts:** eliminate zombie drafts and fix draft/trash unread state ([996b42f](https://github.com/M4lmostoso/melo/commit/996b42fd4c1bfc064b11df0461f69b58400f9acf))
* enforce camelCase for CID requests and remove noisy debug logging ([3985445](https://github.com/M4lmostoso/melo/commit/398544572257e5d9e75e6e4316137c6516eccb91))
* ensure thread read state accuracy by overriding stale Gmail API data with History API events and fix card UI layout ([138934d](https://github.com/M4lmostoso/melo/commit/138934d5567113d8c87f49656a1b851c92608d63))
* exclude drafts from thread message counts and synchronize local state with server by removing orphaned messages ([a8263f8](https://github.com/M4lmostoso/melo/commit/a8263f89934f0fb2c14dbd57f8a05b6969c182e1))
* exclude drafts from thread unread counts and implement auto-extinguish for replied threads ([a67f6af](https://github.com/M4lmostoso/melo/commit/a67f6afff6c855534f730fd387d4d4a4eb042f75))
* exclude drafts/trash from All Mail and fix TipTap startup crash ([0e973a1](https://github.com/M4lmostoso/melo/commit/0e973a13731dfd62fa1f60b6aee99f6d3569c039))
* guard against undefined payload in parseIdToken ([120b0d7](https://github.com/M4lmostoso/melo/commit/120b0d7668791773a976b192c45c5e20bedfbcba))
* handle missing router context in pop-out thread windows ([b484d86](https://github.com/M4lmostoso/melo/commit/b484d86e7b68b7950c432b9d077b5258ed8fdb15))
* hide user labels in sidebar when collapsed to avoid icon ambiguity ([81967c9](https://github.com/M4lmostoso/melo/commit/81967c9cbe6ef29e630957d50798d46b27db2516))
* IMAP action reliability, CSP IPC fix, and smart folder corrections ([a7ec700](https://github.com/M4lmostoso/melo/commit/a7ec700261e7ddf327ff2a6c0fa73e5e83740738))
* IMAP emails not displaying in UI after sync ([18521cf](https://github.com/M4lmostoso/melo/commit/18521cf2cbcb87f75cab25cff21dba9876fb0e31))
* IMAP fetch fallback for servers incompatible with async-imap ([fcc7a45](https://github.com/M4lmostoso/melo/commit/fcc7a45f52e2fe04595d40c0c34926adca5678b4))
* IMAP messages downloaded but not stored in database ([1c28a8e](https://github.com/M4lmostoso/melo/commit/1c28a8e7c3e55dfdd3197ba2011e7b82025767f5)), closes [#39](https://github.com/M4lmostoso/melo/issues/39)
* IMAP trash not working for servers with non-standard folder names ([b6cf2c6](https://github.com/M4lmostoso/melo/commit/b6cf2c6d3aae86fa261fd3b20d938ff8c16f36a9))
* **imap:** add SINCE-date fallback in delta sync for DavMail/Exchange ([b2c11e0](https://github.com/M4lmostoso/melo/commit/b2c11e098da3a3de7461973b2548052cf7a1555a))
* implement scroll-to-thread logic in ThreadView and add concurrency control to EmailList loading ([f1cd075](https://github.com/M4lmostoso/melo/commit/f1cd075af9c59b5f256f729e1d73a57b6f259d92))
* improve calendar deduplication, add in-app reminder toasts, and hash long attachment paths ([094f060](https://github.com/M4lmostoso/melo/commit/094f060f141c7a24ef6e2fa39fe3bb3532ad3512))
* improve email forwarding, thread synchronization, and composer reference handling ([cde1336](https://github.com/M4lmostoso/melo/commit/cde133655bf2a0c45588fc4b34427feb3016512b))
* improve iframe height calculation by observing both document and body elements ([8091a39](https://github.com/M4lmostoso/melo/commit/8091a3938897512aa2baa4318f28b3422044a227))
* improve IMAP sync error handling and reliability ([29ce210](https://github.com/M4lmostoso/melo/commit/29ce210b78c1dccaf0cdef02f1342dcd14f0aedf))
* improve reply-all recipient filtering with smarter email normalization and multi-account support ([6c63a95](https://github.com/M4lmostoso/melo/commit/6c63a957688fc65feefec0d5d48a366926f9a6e0))
* improve sync status bar UX ([dc76dd7](https://github.com/M4lmostoso/melo/commit/dc76dd7e60fec0460a39a4ed5c5427723a52ad32))
* improve thread metadata syncing, enhance contact search, and add download status to attachments ([0fe779c](https://github.com/M4lmostoso/melo/commit/0fe779c39f8ca853156d14ad5fed0e1e9c0c0d2a))
* move early returns after hooks to follow Rule of Hooks in FromSelector and SignatureSelector ([e6d0734](https://github.com/M4lmostoso/melo/commit/e6d0734cb8d24a4811cdee053f92c2a6f4ab4035))
* move release-please annotation to own line in RPM spec ([134746f](https://github.com/M4lmostoso/melo/commit/134746f1c5c5d209d609bec9c8376fe688f6d0d0))
* ollama connection permissions and add AI language setting ([0fa60a4](https://github.com/M4lmostoso/melo/commit/0fa60a4269c46c6865ec49451772724c48037b68))
* ollamaProvide.ts and improvement of draftAutoSave ([2fe20c2](https://github.com/M4lmostoso/melo/commit/2fe20c210cf73035c8cade1f4166f3df5c46dd62))
* only show sync status bar for initial syncs, not delta syncs ([b925610](https://github.com/M4lmostoso/melo/commit/b9256103b9f9f07bb2573f4e539607cbab024e96))
* **popout:** set active account in thread pop-out window ([ae60695](https://github.com/M4lmostoso/melo/commit/ae606950a8c1692a5c935d4ea60d384d1093e7e0))
* preserve selected thread during list updates using ref and update thread map on search result changes ([4276f5a](https://github.com/M4lmostoso/melo/commit/4276f5a65f75a07fb233e576c59ccd1b8569a208))
* prevent duplicate event listener registration by using cancellation flag in useEffect cleanup ([7b6062b](https://github.com/M4lmostoso/melo/commit/7b6062b4209aa39061b500bf4c009cd39c4f4b6d))
* prevent duplicate IMAP draft deletions and ensure sidebar badge refresh ([e25e15b](https://github.com/M4lmostoso/melo/commit/e25e15bba532db0e5bac93cbfd8aae7a9e5cb552))
* prevent IMAP sync OOM on large mailboxes and surface sync errors ([61ebc6e](https://github.com/M4lmostoso/melo/commit/61ebc6ef7b1993c2a15f8c0c022657b275fa62c2)), closes [#74](https://github.com/M4lmostoso/melo/issues/74) [#76](https://github.com/M4lmostoso/melo/issues/76)
* prevent selected thread from disappearing from EmailList during updates by preserving it in the thread state ([20923aa](https://github.com/M4lmostoso/melo/commit/20923aa5f104697bee72ed1edce687bdd692623a))
* prevent skeleton flash in outgoing view by removing loading state and adding reactive refresh hook ([bbd5747](https://github.com/M4lmostoso/melo/commit/bbd57473d79b781ff382ff38a54f1cccd87129c0))
* reduce IMAP sync connection storm with single-connection folder sync ([6b90b7a](https://github.com/M4lmostoso/melo/commit/6b90b7a1bfa0a2a048de6b0746acbf01511eb9cb)), closes [#147](https://github.com/M4lmostoso/melo/issues/147)
* remove underline extension and implement IMAP date-zero parsing repair with automated re-sync and UI cleanup ([7af365c](https://github.com/M4lmostoso/melo/commit/7af365cc2c7079900c728e2739d81ebc711484b5))
* rename tray icon to Template for macOS dark/light mode ([ebf13c9](https://github.com/M4lmostoso/melo/commit/ebf13c9b93fa4947b6cc6daf3ecce61206a6adb4))
* repair broken message snippets and exclude trashed messages from sender lists ([09bea1c](https://github.com/M4lmostoso/melo/commit/09bea1c533c9cc4d2e32804a0fe745b1f6ecf860))
* resolve accountId mismatches by extracting IMAP draft account IDs and standardizing composer state initialization ([f8e0b7a](https://github.com/M4lmostoso/melo/commit/f8e0b7a4f3dccdb8e96a44799ad278442f37f28a))
* resolve context menu bugs on attachment preview and submenu opening ([f1d26b9](https://github.com/M4lmostoso/melo/commit/f1d26b97410a596f8562e175470dddf9eafba433))
* resolve Gmail thread trashing bug and improve forwarded email layout styles ([bd06679](https://github.com/M4lmostoso/melo/commit/bd06679dad259c1d15fef69d8d16662be736a488))
* resolve IMAP attachment fetching and display ([2c40b51](https://github.com/M4lmostoso/melo/commit/2c40b51d87a7c83de6204c170ab057bc11efc08e)), closes [#124](https://github.com/M4lmostoso/melo/issues/124)
* resolve IMAP sync inconsistencies by purging orphan threads, preferring non-placeholder thread IDs, fixing badge counts, and improving remote image detection in CSS. ([3ad4aab](https://github.com/M4lmostoso/melo/commit/3ad4aabc397324af2045ef52c8f51b00ac66124d))
* resolve local AI (Ollama/LMStudio) connection failures ([adfc09f](https://github.com/M4lmostoso/melo/commit/adfc09f6900ab40c11b73767a24fad07d97547c2)), closes [#145](https://github.com/M4lmostoso/melo/issues/145)
* resolve nested button warning and 204 response parsing ([e44f063](https://github.com/M4lmostoso/melo/commit/e44f063927b179444711771e87923343b6599a26))
* resolve nested button warnings, TipTap duplicate extensions, FS scope, and CI type errors ([65c0028](https://github.com/M4lmostoso/melo/commit/65c0028e03315fc7150a1882ed0775344ec345fd))
* resolve over-trashing issues by adding a migration for orphaned Gmail messages and triggering a re-sync when threads fail to load. ([e6bb7b3](https://github.com/M4lmostoso/melo/commit/e6bb7b3de6a090dc2f1dd7ddff186a1a3bd5bc3d))
* resolve SQLite transaction errors during IMAP initial sync ([6044f42](https://github.com/M4lmostoso/melo/commit/6044f429581f6c2142cc536f1eb6299347bfdbeb)), closes [#192](https://github.com/M4lmostoso/melo/issues/192)
* restore of thrashed item into correct thread ([35559cf](https://github.com/M4lmostoso/melo/commit/35559cfd433d16fc6f94d1b9f06afa92077fd6d0))
* revert unsafe img-src CSP and fix image loading for allowlisted senders ([7aeb88f](https://github.com/M4lmostoso/melo/commit/7aeb88fcc66110a07c8115df74df68a1ef4e354d))
* save IMAP/SMTP sent messages to local DB and Sent folder ([3133ee9](https://github.com/M4lmostoso/melo/commit/3133ee9b24324cd2e6e2098a8e66ad48d6cccbe0)), closes [#121](https://github.com/M4lmostoso/melo/issues/121)
* **settings:** use Tauri OS plugin for reliable platform detection ([07b6890](https://github.com/M4lmostoso/melo/commit/07b6890f9a7daeba666414ccf7b66c2e626902a2))
* signature editor extensions, email renderer safety, sync error account label ([8d2c401](https://github.com/M4lmostoso/melo/commit/8d2c401a1393b1842ca46e4089a261a315236e57))
* single message delete ([f6e47ef](https://github.com/M4lmostoso/melo/commit/f6e47efa7e16e4e97f542aa6a5d9b443942bda58))
* smart folder unread count SQL error and sync progress visibility ([7c2eb4e](https://github.com/M4lmostoso/melo/commit/7c2eb4edb6fa2d14f847d194e86fe48d3ee94ee0))
* starred threads not appearing in Starred folder ([a03db9f](https://github.com/M4lmostoso/melo/commit/a03db9f4877988d7d979980f750ff5daf63bc052))
* **sync:** clear sync spinner on velo-sync-done event instead of promise ([a502f04](https://github.com/M4lmostoso/melo/commit/a502f040969f8dc4ba29ecacc057aec26c184e6f))
* **test:** update HelpPage test for 14 categories (added tasks) ([ca97b65](https://github.com/M4lmostoso/melo/commit/ca97b656290781f1d81d944e57445a6f1158f287))
* **ui:** replace loading text with skeleton animation and fix platform detection ([02eda9f](https://github.com/M4lmostoso/melo/commit/02eda9fd35f7272222aa4c5e9f28661230bc754b))
* update calendar reminder window to handle missed events, replace callback with window events, and improve notification resilience ([b2d2d0f](https://github.com/M4lmostoso/melo/commit/b2d2d0f1f8b995a9c89bd631620399224f556524))
* update IMAP UIDs for duplicate messages and clean up orphaned placeholder threads while improving sender display logic in ThreadCard ([f74a1b1](https://github.com/M4lmostoso/melo/commit/f74a1b109a1dee451441704da74bd1ac5c2e2974))
* update print layout margins to align page settings and remove redundant global overrides ([6539bad](https://github.com/M4lmostoso/melo/commit/6539baddb00a1f6e5d659ae9f3439687d925b131))
* update smart folder counts to aggregate data across all global accounts ([7fbf30e](https://github.com/M4lmostoso/melo/commit/7fbf30e2af523033311b169b129b5a2e5a257b2a))
* update velo.spec version to 0.4.11 and fix release-please annotation ([d1d08b2](https://github.com/M4lmostoso/melo/commit/d1d08b2ee6951c71fb6ae7d8bcfceadff465e827))
* use background-image instead of background shorthand in dark mode ([9107b50](https://github.com/M4lmostoso/melo/commit/9107b5081c37082469decc47b178fcd7c15540fb)), closes [#168](https://github.com/M4lmostoso/melo/issues/168)
* use baseDir option for Tauri FS operations to resolve scope errors ([7b463dc](https://github.com/M4lmostoso/melo/commit/7b463dcba326e45c59ac5d2d47b967d05591384a))
* use icon_as_template for tray macOS dark/light mode ([1153610](https://github.com/M4lmostoso/melo/commit/1153610dddbbf00c4c98f7a1a239a349cfc02a30))
* use join() for paths and hash long attachment IDs for filenames ([d01dd79](https://github.com/M4lmostoso/melo/commit/d01dd794dbe02ef0820bc293e7af39bc37deaa45))
* use separate tray icon instead of default app icon ([384aaa2](https://github.com/M4lmostoso/melo/commit/384aaa20761e2403e9d8d45acd136bed3f623780))
* use server-side IMAP SINCE date filter to prevent sync timeouts on large folders ([99d9301](https://github.com/M4lmostoso/melo/commit/99d9301f836b24b2917b1aae05980073a86f4f3d)), closes [#147](https://github.com/M4lmostoso/melo/issues/147)
* use Tauri native fetch for local AI to bypass CORS ([6e84ab2](https://github.com/M4lmostoso/melo/commit/6e84ab2884c261db0ed0a4fec6d223295355a7dc)), closes [#127](https://github.com/M4lmostoso/melo/issues/127)


### Performance Improvements

* implement lazy body fetching with jemalloc memory allocation and database optimizations ([a9e10a3](https://github.com/M4lmostoso/melo/commit/a9e10a3803d6db16274118890a07c476c549944e))
* increase IMAP connection limits and implement local disk caching for attachment fetching ([57ac7ec](https://github.com/M4lmostoso/melo/commit/57ac7ec660120eb30a8df773b5f16dddfed26974))
* memoize calendar event buckets, filter descriptions, and contact search ([3eb6042](https://github.com/M4lmostoso/melo/commit/3eb60425bcff8e60a9fc34e23e2abe6f77fdce09))
* optimize rendering, store subscriptions, and DB queries ([0fd4d8c](https://github.com/M4lmostoso/melo/commit/0fd4d8c784a326f30f334cbf4ace46cd7347677e))
* pre-parse filter JSON and lazy load route components ([33440b7](https://github.com/M4lmostoso/melo/commit/33440b7ed272ac04adbb3186f5d81f77f1e45dec))

## [Melo 0.1.0] — In development

All work described in this section took place in the Melo fork, spread across 230+ commits on top of the Velo 0.4.21 base.

---

### Branding & Identity

- New app and tray icons, including native dark/light mode on macOS via template icon
- Redesigned splash screen with updated palette and skeleton loading animation
- Removed all upstream CI/CD release workflows; version reset to 0.1.0
- **Minimal CI** — GitHub Actions workflow runs type-check + the full test suite on every pull request

---

### Email & IMAP Sync

- **PEC (Certified Email) support** — detection of Italian PEC accounts with a dedicated certified-receipt (Ricevute) folder, automatic receipt reconciliation during IMAP sync, and receipt filtering
- **iCloud Mail support** with dedicated connection rate-limiting and app-specific password warnings
- **IMAP IDLE** — real-time background sync without polling; UI management tabs
- **IMAP session pool** — connection pool with frontend concurrency limits to optimize attachment fetching and database performance
- **Fragmented thread reconciliation** — `reconcileFragmentedThreads` unifies split threads during IMAP sync
- **Tombstone for deleted UIDs** — `deleted_imap_uids` table prevents re-importing deleted messages
- **IMAP message deduplication** — external reconciliation with UID updates for duplicate messages
- **IMAP drafts with synchronous tombstones** — reliable local deletion on composer close
- **Separate SMTP credentials** — distinct SMTP username/password from IMAP; login string sanitization
- **SINCE-date fallback for delta sync** — compatibility with DavMail/Exchange servers that don't support UID ranges
- **Stale state guarding** — protection against stale thread loads during list updates
- **Thread sync on reply** — thread reloaded from server after sending a reply
- Support for `imap_username` credentials separate from the email address as login
- Automatic repair of migration 26 if the `deleted_imap_uids` table is missing
- Batch retry and improved duplicate label handling in IMAP
- IMAP flag synchronization with granular read-state tracking

---

### Composer

- **Pre-send validation** — warns about a missing subject or a forgotten attachment (e.g. "see attached" with no file) before the message goes out
- **Font toolbar** — font family, size, and color picker directly in the composer toolbar
- **AI Sidebar in composer** — integrated AI chat interface for writing assistance
- **Account switcher** — switch accounts in the modal composer without reopening the window
- **Context-aware account selection** — composer opens pre-set to the correct account based on context (search, shortcuts)
- **Conversation history in AI** — AI providers receive the full thread history for more contextual replies
- **BlockStyle TipTap extension** — preserves inline block styling in the rich text editor
- **RFC 2822 References header** — support for References/In-Reply-To thread headers in composer and reply flows
- **Subject-based thread merging** — unifies threads by subject when References headers are missing
- **Quoting aware** — quoted HTML passed as URL parameter for composer initialization; quoting support in pop-out windows
- **Drafts in SQLite** — draft persistence in the database instead of localStorage for cross-window availability
- **Auto-save on window close** — drafts are automatically saved when the composer window closes
- Configurable default font family and size in settings
- Signature correctly placed before quoted text in reply/forward
- Proper composer state reset on fresh compose
- Email sending delegated to the main window; reply keyboard shortcut enabled in pop-out windows

---

### Artificial Intelligence

- **Urgency scoring** — scoring pipeline with temporal decay, legal sender detection, follow-up identification, and disclaimer sanitization
- **Automatic backfill** of urgency scores for existing threads
- **AI Answer Panel (Ask My Inbox)** — answer panel with citations and navigation to cited threads; textarea in SearchBar
- **Hybrid FTS + vector RAG** — search with Reciprocal Rank Fusion in Rust; manual re-indexing from settings; aggregated progress indicator; automatic backfill resume after sync
- **AI phishing arbitration** — AI-assisted adjudication layered on top of the heuristic phishing rules to reduce false positives
- **AI Smart Labels** — automatic content-based labeling for threads
- **AI Urgency Decay** — sender reputation and configurable "heat extinction"
- **SOUL.md** — configurable AI personality via Markdown file with settings UI and file monitoring
- **Semantic result merging** — semantic unification of results with citations in threads
- Urgency scoring prompts now return rationales explaining each score
- Thread context and past user replies injected into the AI prompt for personalization
- Task extraction from emails with multi-task support and target language injection into the prompt

---

### Task Manager

- **Email–task linking** — link an email to a task from a dedicated UI; the active account follows the linked thread on navigation
- **Task panel** integrated in the sidebar with tags and deadline tracking
- **TasksDayPanel** — weekly scheduling view for daily tasks
- **AI task extraction** — automatic task extraction from emails with sidebar grouping
- **Inline editing** of tasks directly in the list
- **Configurable retention** — task retention period setting in preferences
- **Account-based badges** — per-account task counters in the system tray and sidebar
- **Unified inbox mode** for tasks with updated route navigation
- Active account updated when navigating to a thread linked to a task
- Task badges periodically refreshed and auto-updated after mutations

---

### Calendar

- **Sync reconciliation** — local calendar state reconciled against the server so events deleted or moved remotely are dropped locally
- **CalDAV synchronization** — calendar metadata, colors, events, and invite responses
- **Unified view** — aggregation of events and calendars across all accounts
- **Client-side RRULE expansion** — recurring event expansion on the client for CalDAV providers that lack native support
- **Meeting join buttons** — "Join" buttons with URL parsing for Zoom/Meet/Teams links in event views
- **Interactive month picker** — quick month selection in the calendar toolbar
- **Auto-scroll to current time** with a visual time indicator in WeekView
- **Dynamic event colors** — color coding per calendar in all views
- **Background reminders** — desktop notifications for upcoming events
- Respond to calendar invites directly from the attachment in email
- **Automatic pruning** of accepted/expired calendar invites
- **Calendar smart folder** for quick navigation to events
- Full localization of calendar headers, titles, and time formatting
- Week layout with absolute event positioning and correct Monday-first logic
- Correct end-time calculation for all-day events

---

### Search & Contacts

- **Contact autocomplete in SearchBar** — auto-complete suggestions for senders/recipients in the search bar
- **Batched DB queries** — optimized database queries for search with direct result hydration into the thread store
- **Contact display name caching** — dedicated store for caching display names across UI components
- **Google Contacts sync** — Google Contacts synchronization for Gmail accounts
- **Contact sidebar** — contact panel updated based on the selected message sender
- Detailed sender contact information stored in threads with name parsing in the UI
- Frequency-ranked contact autocomplete in the composer

---

### Accounts & Multi-account

- **Multi-account with labels** — optional label field for custom account identification
- **Unified view** — cross-account inbox and folders with global account settings
- **Drag-and-drop ordering** — drag-and-drop reordering of mail accounts in settings
- **Account creation flow** — add account flow integrated in the settings page
- **Per-account sync status indicators** — visual badges per account in the sidebar
- **Account colors** — derived from account object properties instead of email hashing
- **Cross-account smart folders** — saved searches that aggregate data across all global accounts
- **Unified cross-account labels** — shared folder support across multiple accounts
- Global aggregated unread counters per account in the sidebar and tray

---

### UI & Design

- **Catppuccin Mocha palette** — dark mode redesign with Zed/Catppuccin Mocha colors
- **Theme overhaul** — new color palette definitions, global styles, and updated 8 accent presets
- **Swipe-to-action** — swipe gestures to archive/delete threads via pointer and trackpad, with scrollTracker to prevent accidental gestures
- **SwipeableThreadCard** — thread card component with built-in swipe support
- **Sound effects** — configurable sound effects system with notification and action triggers
- **Unread message indicator** — visual badge in MessageItem components
- **Attachment icon** on thread cards in the email list
- **Office document preview** — Word/Excel/PowerPoint preview directly in-app
- **Local file preview modal** — modal for previewing local files
- **Empty state illustrations** — illustrations for empty views
- **Floating sync pill** — sync status bar converted to a floating pill in the bottom-right corner
- **ContactChip hover cards** — contact preview cards on hover, with navigation to a focused contact sidebar
- **Manual mail sync button** in the macOS sidebar for on-demand sync
- **Multi-select attachments** — multi-select with drag-and-drop and native app integration
- **Native macOS traffic lights** — semaphore buttons in the sidebar for native window control
- **Window dragging** — `data-tauri-drag-region` on the main layout and fullpage composer
- **Print email** — printing with threading, signatures, dedicated CSS print styles, and dynamic document title
- **Per-message action support** — contextual actions for individual messages in a thread
- Skeleton animation on loading (replaces loading text)
- Auto-scroll to selected thread with ResizeObserver; concurrency control in EmailList loading
- Auto-advance to next thread after removal actions
- Visual highlight for spam threads with dimmed red background

---

### Scheduled Emails

- **Scheduled emails view** — dedicated panel with list and detail views for outgoing scheduled emails
- **Context menu** on the scheduled list with multi-action support and attachments
- **Cross-window sync** of scheduled emails via Tauri events
- **Multi-account bulk actions** for spam/trash

---

### Outgoing Queue

- **Outgoing view** — sidebar section with persistent and in-memory tracking of outgoing emails
- **Failed send queue** — dedicated view for failed messages with retry support
- **Edit queued emails** — modify outgoing messages before they send; in-flight items shown in the queue view

---

### Internationalization (i18n)

- **Full i18n refactor** — replaced all hardcoded strings with `t()` calls across 71+ components
- **Italian locale** (`it-IT.json`) — full Italian translation of the interface
- **Multi-language email headers** — forward/reply headers localized based on account language
- Localization of sidebar, smart folders, labels, shortcuts, and all main components

---

### Security & Privacy

- **Production log stripping** — `console.log`/`console.debug` removed from release builds (warnings/errors kept) to avoid console noise and incidental data exposure
- **Nonce-based message verification** — iframe message verification with nonce to resolve WKWebView issues
- **iframe srcdoc** — migration from `blob:` URLs to `srcdoc` in EmailRenderer for improved security
- **postMessage link handling** — secure iframe link handling via postMessage with sandbox restriction
- CSP fix for inline scripts and stable iframe height calculation
- Improved remote image detection in CSS

---

### Performance

- **jemalloc** — optimized memory allocation for sync operations
- **Lazy body fetching** — lazy message body retrieval with backpressure via semaphores
- **Body caching** — local cache of email bodies to reduce server requests
- **Attachment disk caching** — on-disk attachment cache with optimized memory management
- **Raw TCP attachment fetching** — bypasses IMAP parser hangs with a fallback discovery path for legacy messages
- **Batched IMAP CID resolution** — batch CID image resolution on the Rust side to reduce memory footprint
- **Batched DB queries** — batch database queries for search and thread loading
- ResizeObserver for frame height calculation (avoids layout thrashing)
- Removed `MAX_THREAD_STORE_SIZE` limit for email list pagination

---

### Notable Bug Fixes (Melo)

- Prevent duplicate IMAP draft deletions and ensure sidebar badge refresh
- Exclude drafts from unread counters and thread message counts
- Reply-all with correct recipient filtering and multi-account support
- Restore trashed items to the correct thread
- Sync local state with server by removing orphaned messages
- Fix race conditions in thread loading during list updates
- Correct read state by overriding stale Gmail API data with History API events
- Prevent skeleton flash in the Outgoing view
- Proper iframe height handling on WKWebView
- Fix unread count calculation for smart folders in global mode
- Resolve over-trashing of Gmail threads — migration for orphaned messages plus an automatic re-sync when a thread fails to load

---

## Foundation inherited from Velo 0.4.21

Velo 0.4.21 already provided: multi-account Gmail/Outlook/IMAP with OAuth2 PKCE, JWZ threading, full-text search with Gmail-style operators, command palette, AI-categorized split inbox, TipTap rich text editor with undo send/schedule send/auto-save draft, multiple signatures, templates, smart folders, snooze, filters, follow-up reminders, one-click unsubscribe, newsletter bundling, quick steps, five AI providers (Claude/OpenAI/Gemini/Ollama/Copilot), Google Calendar, glassmorphism design with dark/light theme and 8 accent presets, resizable reading pane, customizable keyboard shortcuts, OAuth PKCE without a backend, AES-256-GCM encryption, phishing detection, DOMPurify sandbox, tray badge, auto-update, and cross-platform distribution (Windows/macOS/Linux).
