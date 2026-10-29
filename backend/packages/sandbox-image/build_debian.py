# Build the Debian 13 / Chrome desktop template against the self-hosted E2B here.
import os

from e2b import Template, default_build_logger
from prepare_assets import ARCHIVE_PATH, build_archive
from template_debian import template_with_user_workdir

# Bundle tracked plain source into one deterministic archive immediately
# before the build, so the recipe installs a single COPY plus a single RUN.
# The binary tar is never checked in: it is removed afterwards even when the
# build fails.
try:
    build_archive()
    Template.build(
        template_with_user_workdir,
        alias=os.environ.get("TEMPLATE_ALIAS", "desktop-debian"),
        cpu_count=2,
        memory_mb=2048,
        on_build_logs=default_build_logger(),
    )
finally:
    if os.path.exists(ARCHIVE_PATH):
        os.remove(ARCHIVE_PATH)
