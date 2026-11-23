-- teacher salutation: m/w/d -> m/f/d ("w" for "weiblich" becomes "f" for "female")
UPDATE "subjects" SET "teacherGender" = 'f' WHERE "teacherGender" = 'w';
