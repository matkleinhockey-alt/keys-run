CREATE TABLE "audit_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"catch_id" uuid,
	"reason" text NOT NULL,
	"severity" integer DEFAULT 1 NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"species_key" text NOT NULL,
	"weight_lb" numeric(7, 2) NOT NULL,
	"caught_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspicion" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_records" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"catch_id" uuid NOT NULL,
	"species_key" text NOT NULL,
	"weight_lb" numeric(7, 2) NOT NULL,
	"catch_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"resume" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "species_records" (
	"species_key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"catch_id" uuid NOT NULL,
	"weight_lb" numeric(7, 2) NOT NULL,
	"caught_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"seed" bigint NOT NULL,
	"content_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_flags" ADD CONSTRAINT "audit_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_flags" ADD CONSTRAINT "audit_flags_catch_id_catches_id_fk" FOREIGN KEY ("catch_id") REFERENCES "public"."catches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catches" ADD CONSTRAINT "catches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_records" ADD CONSTRAINT "global_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_records" ADD CONSTRAINT "global_records_catch_id_catches_id_fk" FOREIGN KEY ("catch_id") REFERENCES "public"."catches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "species_records" ADD CONSTRAINT "species_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "species_records" ADD CONSTRAINT "species_records_catch_id_catches_id_fk" FOREIGN KEY ("catch_id") REFERENCES "public"."catches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_flags_user_id_idx" ON "audit_flags" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "catches_user_id_caught_at_idx" ON "catches" USING btree ("user_id","caught_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catches_species_key_weight_lb_idx" ON "catches" USING btree ("species_key","weight_lb" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catches_suspicion_idx" ON "catches" USING btree ("suspicion") WHERE "catches"."suspicion" > 0;--> statement-breakpoint
CREATE INDEX "global_records_weight_lb_idx" ON "global_records" USING btree ("weight_lb" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_display_name_lower_idx" ON "users" USING btree (lower("display_name"));