using Xunit;

public class HonestTests
{
    [Fact]
    public void Adds()
    {
        Assert.Equal(2, 1 + 1);
    }

    [Fact]
    public void Differs()
    {
        Assert.NotEqual("a", "b");
    }
}
