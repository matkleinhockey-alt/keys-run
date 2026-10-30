CREATE TABLE "ocean_cells" (
	"cx" integer NOT NULL,
	"cz" integer NOT NULL,
	"pressure" double precision NOT NULL,
	"last_caught_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocean_cells_cx_cz_pk" PRIMARY KEY("cx","cz")
);
