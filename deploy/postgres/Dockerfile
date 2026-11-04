# PostgreSQL 18 on the same Alpine base as earlier releases (existing volumes keep their collation),
# plus the pgvector extension that memory search needs (migration 0072). pgvector is built from a
# pinned release and the build tools are removed afterwards.
FROM postgres:18-alpine
ARG PGVECTOR_VERSION=0.8.1
ARG PGVECTOR_SHA256=a9094dfb85ccdde3cbb295f1086d4c71a20db1d26bf1d6c39f07a7d164033eb4
RUN set -eux; \
  apk add --no-cache --virtual .build-deps build-base curl; \
  curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" -o /tmp/pgvector.tar.gz; \
  echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c -; \
  mkdir /tmp/pgvector; tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector --strip-components=1; \
  make -C /tmp/pgvector OPTFLAGS="" with_llvm=no; \
  make -C /tmp/pgvector install with_llvm=no; \
  rm -rf /tmp/pgvector /tmp/pgvector.tar.gz; \
  apk del .build-deps
