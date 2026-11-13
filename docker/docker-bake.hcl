// The fork's image: its own base (docker/debian-base.dockerfile, Node pinned
// by digest there) and the release built on it. Build with:
//   docker buildx bake -f docker/docker-bake.hcl release
// Without buildx, build the base first and pass it as BASE_IMAGE:
//   podman build -f docker/debian-base.dockerfile --target base2 -t kuma-base2 .
//   podman build -f docker/dockerfile --target release --build-arg BASE_IMAGE=localhost/kuma-base2 .

target "base" {
  context    = "."
  dockerfile = "docker/debian-base.dockerfile"
  target     = "base2"
  platforms  = ["linux/amd64"]
}

target "release" {
  context    = "."
  dockerfile = "docker/dockerfile"
  target     = "release"
  platforms  = ["linux/amd64"]
  contexts = {
    base2 = "target:base"
  }
}
