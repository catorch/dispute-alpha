CREATE TABLE `audit_export` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`params_json` text NOT NULL,
	`status` text NOT NULL,
	`document_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`session_id` text,
	`request_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`diff_json` text,
	`ip_hash` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_created` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_org_created` ON `audit_log` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `client` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`assigned_staff_id` text,
	`status` text DEFAULT 'intake' NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`address_json` text NOT NULL,
	`dob_enc` text NOT NULL,
	`ssn_enc` text NOT NULL,
	`ssn_last4` text NOT NULL,
	`ssn_hmac` text NOT NULL,
	`auth_status` text DEFAULT 'none' NOT NULL,
	`sms_opt_in` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `client_org_status` ON `client` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `client_assigned` ON `client` (`assigned_staff_id`);--> statement-breakpoint
CREATE INDEX `client_ssn_hmac` ON `client` (`org_id`,`ssn_hmac`);--> statement-breakpoint
CREATE TABLE `client_account` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`client_id` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`mfa_type` text NOT NULL,
	`totp_secret_enc` text,
	`totp_last_step` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`failed_logins` integer DEFAULT 0 NOT NULL,
	`locked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_account_email` ON `client_account` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `client_account_client` ON `client_account` (`client_id`);--> statement-breakpoint
CREATE TABLE `dispute_round` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`client_id` text NOT NULL,
	`number` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dispute_round_client_number` ON `dispute_round` (`client_id`,`number`);--> statement-breakpoint
CREATE TABLE `document` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`client_id` text,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`bucket` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`encrypted` integer DEFAULT false NOT NULL,
	`uploaded_by_kind` text NOT NULL,
	`uploaded_by_id` text,
	`scan_result_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `document_client` ON `document` (`client_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `document_status` ON `document` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `esign_request` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`client_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_request_id` text NOT NULL,
	`status` text NOT NULL,
	`signed_document_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `esign_provider_request` ON `esign_request` (`provider_request_id`);--> statement-breakpoint
CREATE INDEX `esign_client` ON `esign_request` (`client_id`);--> statement-breakpoint
CREATE TABLE `flag` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`report_item_id` text NOT NULL,
	`rule_id` text,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `flag_item` ON `flag` (`report_item_id`);--> statement-breakpoint
CREATE TABLE `flag_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`item_types_json` text NOT NULL,
	`condition_json` text,
	`reason_template` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `flag_rule_org` ON `flag_rule` (`org_id`);--> statement-breakpoint
CREATE TABLE `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`client_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`mfa_type` text,
	`pending_totp_enc` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_token` ON `invite` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invite_expires` ON `invite` (`expires_at`);--> statement-breakpoint
CREATE TABLE `key_rotation` (
	`id` text PRIMARY KEY NOT NULL,
	`to_version` integer NOT NULL,
	`table_name` text NOT NULL,
	`last_id` text,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `letter` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`client_id` text NOT NULL,
	`dispute_round_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_name` text NOT NULL,
	`template_id` text NOT NULL,
	`template_version` integer NOT NULL,
	`status` text NOT NULL,
	`body_html` text NOT NULL,
	`locked_at` integer,
	`approved_by` text,
	`approved_at` integer,
	`rejection_reason` text,
	`pdf_document_id` text,
	`pipeline_workflow_id` text,
	`sent_at` integer,
	`tracking_number` text,
	`response_due_at` integer,
	`deadline_workflow_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `letter_status` ON `letter` (`status`);--> statement-breakpoint
CREATE INDEX `letter_due` ON `letter` (`response_due_at`);--> statement-breakpoint
CREATE INDEX `letter_client` ON `letter` (`client_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `letter_round` ON `letter` (`dispute_round_id`);--> statement-breakpoint
CREATE TABLE `letter_attachment` (
	`letter_id` text NOT NULL,
	`document_id` text NOT NULL,
	PRIMARY KEY(`letter_id`, `document_id`)
);
--> statement-breakpoint
CREATE TABLE `letter_item` (
	`letter_id` text NOT NULL,
	`report_item_id` text NOT NULL,
	`reason` text,
	`outcome` text,
	PRIMARY KEY(`letter_id`, `report_item_id`)
);
--> statement-breakpoint
CREATE INDEX `letter_item_report_item` ON `letter_item` (`report_item_id`);--> statement-breakpoint
CREATE TABLE `letter_template` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`body_html` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `letter_template_name_version` ON `letter_template` (`org_id`,`name`,`version`);--> statement-breakpoint
CREATE TABLE `mfa_challenge` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mfa_challenge_subject` ON `mfa_challenge` (`subject_id`);--> statement-breakpoint
CREATE TABLE `note` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`client_id` text NOT NULL,
	`body` text NOT NULL,
	`author_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `note_client` ON `note` (`client_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`recipient_kind` text NOT NULL,
	`recipient_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`link` text,
	`read_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_recipient` ON `notification` (`recipient_kind`,`recipient_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `notification_delivery` (
	`message_id` text NOT NULL,
	`channel` text NOT NULL,
	`delivered_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `channel`)
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `password_reset` (
	`id` text PRIMARY KEY NOT NULL,
	`client_account_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `password_reset_token` ON `password_reset` (`token_hash`);--> statement-breakpoint
CREATE INDEX `password_reset_expires` ON `password_reset` (`expires_at`);--> statement-breakpoint
CREATE TABLE `report` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`client_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_ref` text,
	`status` text NOT NULL,
	`workflow_id` text,
	`raw_object_key` text,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `report_client` ON `report` (`client_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `report_status` ON `report` (`status`,`requested_at`);--> statement-breakpoint
CREATE INDEX `report_provider_ref` ON `report` (`provider_ref`);--> statement-breakpoint
CREATE TABLE `report_item` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`report_id` text NOT NULL,
	`client_id` text NOT NULL,
	`bureau` text NOT NULL,
	`item_type` text NOT NULL,
	`furnisher` text,
	`account_number_enc` text,
	`account_mask` text,
	`balance` real,
	`credit_limit` real,
	`opened_at` text,
	`reported_at` text,
	`status` text,
	`payment_history_json` text,
	`details_json` text DEFAULT '{}' NOT NULL,
	`fingerprint` text NOT NULL,
	`outcome` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `report_item_report` ON `report_item` (`report_id`);--> statement-breakpoint
CREATE INDEX `report_item_fp` ON `report_item` (`client_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `response` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`letter_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`document_id` text,
	`notes` text,
	`logged_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `response_letter` ON `response` (`letter_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`principal_kind` text NOT NULL,
	`principal_id` text NOT NULL,
	`org_id` text NOT NULL,
	`mfa_pending` integer DEFAULT false NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_hash` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token` ON `session` (`token_hash`);--> statement-breakpoint
CREATE INDEX `session_expires` ON `session` (`expires_at`);--> statement-breakpoint
CREATE INDEX `session_principal` ON `session` (`principal_kind`,`principal_id`);--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`assignee_id` text NOT NULL,
	`title` text NOT NULL,
	`due_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`dedupe_key` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_assignee_status` ON `task` (`assignee_id`,`status`);--> statement-breakpoint
CREATE INDEX `task_entity` ON `task` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_dedupe` ON `task` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`reauth_after` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email` ON `user` (`email`);--> statement-breakpoint
CREATE INDEX `user_org` ON `user` (`org_id`);--> statement-breakpoint
CREATE TABLE `webhook_event` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_event_provider_event` ON `webhook_event` (`provider`,`provider_event_id`);