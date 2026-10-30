FROM ubuntu:24.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends g++ gcc make libmysqlclient-dev ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY server/ ./
RUN make MAKEFLAGS=-j2 && ./spheresvr --help

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends libmysqlclient21 libstdc++6 tzdata ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /source/spheresvr /opt/sphere/spheresvr
COPY shard/ /opt/shard/
COPY seed/ /opt/seed/
COPY start.sh run-server.sh /opt/gemwright/
RUN chmod +x /opt/gemwright/*.sh
WORKDIR /app
EXPOSE 2593
ENTRYPOINT ["/opt/gemwright/start.sh"]
