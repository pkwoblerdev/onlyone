using Xunit;

public class FakeGreenTests
{
    [Fact(Skip = "later")]
    public void Skipped()
    {
        Assert.Equal(2, 1 + 1);
    }

    [Fact]
    public void Tautology()
    {
        Assert.True(true);
    }
}
